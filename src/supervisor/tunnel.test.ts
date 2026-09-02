import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { type AbsPath } from "../domain/types.ts";
import { boxPathsFrom } from "./paths.ts";
import { nodeFs, nodeProcs, type FsDeps, type ProcDeps, parseOwnedPid } from "./procs.ts";
import {
  exposeFilePresent,
  parseQuickTunnelUrl,
  readExposeFile,
  reconcileExpose,
  trycloudflareProbeOk,
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

function tunnelDeps(urls: string[] = ["https://openbot-test.trycloudflare.com"]): {
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
  let nextPid = 88;
  let startCount = 0;
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
      tunnelPid = nextPid;
      nextPid += 1;
      const url = urls[Math.min(startCount, urls.length - 1)] ?? urls[urls.length - 1];
      startCount += 1;
      const prev = fs.read(input.log) ?? "";
      fs.write(
        input.log,
        `${prev}2026-08-31 INF |  ${url}                                                   |\n`,
      );
      fs.write(input.pidFile, `${String(tunnelPid)}\n`);
      return parseOwnedPid(tunnelPid);
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

function fakeDownload(ctx: ReturnType<typeof tunnelDeps>) {
  return {
    async download(_url: string, dest: AbsPath) {
      ctx.deps.fs.write(dest, "fake-cloudflared\n");
    },
  };
}

test("parseQuickTunnelUrl reads a trycloudflare address from cloudflared logs", () => {
  const url = parseQuickTunnelUrl(
    "INF |  https://words-words-words.trycloudflare.com                                      |\n",
  );
  assert.equal(url, "https://words-words-words.trycloudflare.com");
});

test("parseQuickTunnelUrl keeps the last trycloudflare address when the log was appended", () => {
  const url = parseQuickTunnelUrl(
    "INF |  https://openbot-old.trycloudflare.com |\nINF |  https://openbot-new.trycloudflare.com |\n",
  );
  assert.equal(url, "https://openbot-new.trycloudflare.com");
});

test("trycloudflareProbeOk treats expired hostnames as dead and origin blips as live", () => {
  assert.equal(trycloudflareProbeOk(200), true);
  assert.equal(trycloudflareProbeOk(302), true);
  assert.equal(trycloudflareProbeOk(502), true);
  assert.equal(trycloudflareProbeOk(503), true);
  assert.equal(trycloudflareProbeOk(404), false);
  assert.equal(trycloudflareProbeOk(410), false);
  assert.equal(trycloudflareProbeOk(530), false);
  assert.equal(trycloudflareProbeOk(0), false);
});

test("readExposeFile treats missing and off as loopback", () => {
  const fs = memoryFs();
  const path = "/tmp/openbot-expose" as AbsPath;
  assert.equal(readExposeFile(fs, path).kind, "loopback");
  assert.equal(exposeFilePresent(fs, path), false);
  fs.write(path, "   \n");
  assert.equal(exposeFilePresent(fs, path), false);
  fs.write(path, "cloudflare-quick\n");
  assert.equal(readExposeFile(fs, path).kind, "cloudflare-quick");
  assert.equal(exposeFilePresent(fs, path), true);
  fs.write(path, "loopback\n");
  assert.equal(exposeFilePresent(fs, path), true);
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
  const observed = await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, fakeDownload(ctx));
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

test("cloudflare-quick keeps a live cached URL without starting again", async () => {
  const ctx = tunnelDeps();
  const probed: string[] = [];
  const net = {
    ...fakeDownload(ctx),
    async probeUrl(url: string) {
      probed.push(url);
      return true;
    },
  };
  const first = await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, net);
  const second = await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, net);
  assert.equal(first.kind, "cloudflare-quick");
  assert.equal(second.kind, "cloudflare-quick");
  if (first.kind !== "cloudflare-quick" || second.kind !== "cloudflare-quick") {
    return;
  }
  assert.equal(first.url, second.url);
  assert.equal(ctx.started.length, 1);
  assert.deepEqual(probed, ["https://openbot-test.trycloudflare.com"]);
});

test("cloudflare-quick replaces a dead cached URL and truncates the old log", async () => {
  const ctx = tunnelDeps(["https://openbot-old.trycloudflare.com", "https://openbot-new.trycloudflare.com"]);
  const first = await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, {
    ...fakeDownload(ctx),
    async probeUrl() {
      return false;
    },
  });
  assert.equal(first.kind, "cloudflare-quick");
  if (first.kind !== "cloudflare-quick") {
    return;
  }
  assert.equal(first.url, "https://openbot-old.trycloudflare.com");
  const second = await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, {
    ...fakeDownload(ctx),
    async probeUrl() {
      return false;
    },
  });
  assert.equal(second.kind, "cloudflare-quick");
  if (second.kind !== "cloudflare-quick") {
    return;
  }
  assert.equal(second.url, "https://openbot-new.trycloudflare.com");
  assert.equal(ctx.started.length, 2);
  assert.equal(ctx.stopped.includes(88), true);
  const log = ctx.deps.fs.read(ctx.deps.paths.tunnelLog) ?? "";
  assert.equal(log.includes("openbot-old.trycloudflare.com"), false);
  assert.match(log, /openbot-new\.trycloudflare\.com/);
});

test("a missing cloudflared binary surfaces an error state without crashing the process", async () => {
  const dir = mkdtempSync("/tmp/openbot-tunnel-");
  try {
    const paths = boxPathsFrom({ repoRoot: "/tmp/openbot-test-repo", sandData: dir });
    // Real filesystem and process deps so the actual spawn() runs and fails with
    // ENOENT against the absent binary — exactly the production crash path.
    const deps: TunnelDeps = { paths, fs: nodeFs(), procs: nodeProcs() };
    // A download that "succeeds" without writing the binary leaves cloudflared
    // missing, forcing the spawn path to hit the absent file.
    const net = {
      async download(_url: string, _dest: AbsPath) {
        /* no-op: the binary stays missing */
      },
    };
    const observed = await reconcileExpose({ kind: "cloudflare-quick" }, deps, net);
    assert.equal(observed.kind, "error");
    if (observed.kind !== "error") {
      return;
    }
    assert.match(observed.message, /cloudflared not found at/);
    assert.match(observed.message, /bin\/cloudflared/);
    // No pid was written, so a later /api/state reports the tunnel as off.
    assert.equal(deps.fs.read(deps.paths.tunnelPid), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
