import assert from "node:assert/strict";
import test from "node:test";
import { type AbsPath } from "../domain/types.ts";
import { boxPathsFrom } from "./paths.ts";
import { type FsDeps, type ProcDeps, parseOwnedPid } from "./procs.ts";
import {
  parseQuickTunnelUrl,
  readExposeFile,
  reconcileExpose,
  type TunnelDeps,
} from "./tunnel.ts";

function memoryFs(init: Record<string, string> = {}): FsDeps & { files: Record<string, string> } {
  const files: Record<string, string> = { ...init };
  return {
    files,
    read(path) {
      return Object.prototype.hasOwnProperty.call(files, path) ? files[path] : undefined;
    },
    write(path, body) {
      files[path] = body;
    },
    copy(from, to) {
      const src = files[from];
      if (src !== undefined) {
        files[to] = src;
      }
    },
    remove(path) {
      delete files[path];
    },
    exists(path) {
      return Object.prototype.hasOwnProperty.call(files, path);
    },
    mkdirp() {},
  };
}

function tunnelDeps(): {
  deps: TunnelDeps & { fs: ReturnType<typeof memoryFs> };
  started: string[];
  stopped: number[];
} {
  const paths = boxPathsFrom({
    repoRoot: "/tmp/openbot-test-repo",
    sandData: "/tmp/openbot-test-data",
    hostMain: "/tmp/openbot-test-host/host-main.cjs",
  });
  const fs = memoryFs();
  const started: string[] = [];
  const stopped: number[] = [];
  let tunnelPid: number | undefined;
  const procs: ProcDeps = {
    async port() {
      return false;
    },
    readPidFile(path) {
      if (String(path).endsWith("openbot-tunnel.pid")) {
        return tunnelPid;
      }
      return undefined;
    },
    pidAlive(pid) {
      return pid === tunnelPid;
    },
    start(input) {
      started.push([input.command ?? "node", ...input.argv].join(" "));
      tunnelPid = 88;
      fs.write(
        input.log,
        "2026-08-31 INF |  https://openbot-test.trycloudflare.com                                                   |\n",
      );
      fs.write(input.pidFile, "88\n");
      return parseOwnedPid(88);
    },
    stop(pid) {
      stopped.push(pid);
      if (pid === tunnelPid) {
        tunnelPid = undefined;
      }
    },
    hostPids() {
      return [];
    },
    opengrokHopPids() {
      return [];
    },
    term() {},
    syntaxCheck() {
      return { ok: true };
    },
  };
  return { deps: { paths, fs, procs }, started, stopped };
}

test("parseQuickTunnelUrl reads a trycloudflare address from cloudflared logs", () => {
  const url = parseQuickTunnelUrl(
    "INF |  https://words-words-words.trycloudflare.com                                      |\n",
  );
  assert.equal(url, "https://words-words-words.trycloudflare.com");
});

test("readExposeFile treats missing and off as loopback", () => {
  const fs = memoryFs();
  const path = "/tmp/openbot-expose" as AbsPath;
  assert.equal(readExposeFile(fs, path).kind, "loopback");
  fs.write(path, "cloudflare-quick\n");
  assert.equal(readExposeFile(fs, path).kind, "cloudflare-quick");
});

test("loopback expose stops a running tunnel without waiting", async () => {
  const ctx = tunnelDeps();
  ctx.deps.procs.start({
    command: "/tmp/cloudflared",
    argv: ["tunnel"],
    env: {},
    log: ctx.deps.paths.tunnelLog,
    pidFile: ctx.deps.paths.tunnelPid,
  });
  const observed = await reconcileExpose({ kind: "loopback" }, ctx.deps);
  assert.equal(observed.kind, "off");
  assert.equal(ctx.stopped.includes(88), true);
  assert.equal(ctx.deps.fs.read(ctx.deps.paths.expose)?.trim(), "loopback");
});

test("cloudflare-quick downloads cloudflared, starts it, and caches the URL", async () => {
  const ctx = tunnelDeps();
  const observed = await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, {
    async download(_url, dest) {
      ctx.deps.fs.write(dest, "fake-cloudflared\n");
    },
  });
  assert.equal(observed.kind, "cloudflare-quick");
  if (observed.kind !== "cloudflare-quick") {
    return;
  }
  assert.equal(observed.url, "https://openbot-test.trycloudflare.com");
  assert.equal(observed.internal, "http://127.0.0.1:9280");
  assert.equal(observed.pid, 88);
  assert.equal(ctx.started.some((row) => row.includes("tunnel --no-autoupdate")), true);
  assert.match(ctx.deps.fs.read(ctx.deps.paths.tunnelCache) ?? "", /openbot-test\.trycloudflare\.com/);
});
