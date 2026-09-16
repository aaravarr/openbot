import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { type AbsPath } from "../domain/types.ts";
import { boxPathsFrom } from "./paths.ts";
import { nodeFs, nodeProcs, type FsDeps, type ProcDeps, parseOwnedPid } from "./procs.ts";
import {
  exposeFilePresent,
  parseQuickTunnelUrl,
  readCachedTunnelUrl,
  readExposeFile,
  readTunnelCache,
  reconcileExpose,
  type TunnelDeps,
  type TunnelNet,
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
    append(path, body) {
      files[path] = `${files[path] ?? ""}${body}`;
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

/** One row of the events channel, as `payload/request-log.cjs` reads it. */
function eventRows(ctx: ReturnType<typeof tunnelDeps>): Array<Record<string, unknown>> {
  const raw = ctx.deps.fs.read(ctx.deps.paths.eventsLog) ?? "";
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function tunnelDeps(urls: string[] = ["https://openbot-test.trycloudflare.com"]): {
  deps: TunnelDeps & { fs: ReturnType<typeof memoryFs> };
  started: string[];
  stopped: number[];
  /** The cloudflared process dies without any cleanup: pidfile and cache stay. */
  kill(pid: number): void;
} {
  const paths = boxPathsFrom({
    repoRoot: "/tmp/openbot-test-repo",
    sandData: "/tmp/openbot-test-data",
    hostMain: "/tmp/openbot-test-host/host-main.cjs",
  });
  const fs = memoryFs();
  const started: string[] = [];
  const stopped: number[] = [];
  // Liveness and the pidfile are separate facts, exactly as on a real box: a
  // killed process leaves its pidfile (and its cache) behind.
  const live = new Set<number>();
  let nextPid = 88;
  let startCount = 0;
  const procs: ProcDeps = {
    async port() {
      return false;
    },
    readPidFile(path) {
      const raw = fs.read(path);
      if (raw === undefined) {
        return undefined;
      }
      const pid = Number(raw.trim());
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    },
    pidAlive(pid) {
      return live.has(pid);
    },
    start(input) {
      started.push([input.command ?? "node", ...input.argv].join(" "));
      const pid = nextPid;
      nextPid += 1;
      const url = urls[Math.min(startCount, urls.length - 1)] ?? urls[urls.length - 1];
      startCount += 1;
      // cloudflared appends to its log; it never rewrites it.
      const prev = fs.read(input.log) ?? "";
      fs.write(
        input.log,
        `${prev}2026-08-31 INF |  ${url}                                                   |\n`,
      );
      fs.write(input.pidFile, `${String(pid)}\n`);
      live.add(pid);
      return parseOwnedPid(pid);
    },
    stop(pid) {
      stopped.push(pid);
      live.delete(pid);
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
  return {
    deps: { paths, fs, procs },
    started,
    stopped,
    kill(pid) {
      live.delete(pid);
    },
  };
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

test("an unchanged expose is not rewritten", async () => {
  const ctx = tunnelDeps();
  await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, fakeDownload(ctx));
  const written = ctx.deps.fs.read(ctx.deps.paths.expose);
  // A steady-state reconcile is read-only for this file: stamp an out-of-band
  // value and prove the next call left it exactly as it found it.
  ctx.deps.fs.write(ctx.deps.paths.expose, "cloudflare\n");
  await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, fakeDownload(ctx));
  assert.equal(ctx.deps.fs.read(ctx.deps.paths.expose), "cloudflare\n");
  assert.equal(written?.trim(), "cloudflare-quick");
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
  // The first start is history too: an INFO tunnel.start row naming the URL.
  const events = eventRows(ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "tunnel.start");
  assert.equal(events[0]?.severity, "INFO");
  assert.match(String(events[0]?.message), /https:\/\/openbot-test\.trycloudflare\.com/);
  assert.match(String(events[0]?.id), /^[A-Za-z0-9._-]{8,80}$/);
});

test("a live cloudflared keeps its URL no matter what the public URL answers", async () => {
  const ctx = tunnelDeps();
  const probed: string[] = [];
  // A probe that always fails: the exact box-in-China case (CF edge
  // unreachable, new hostname not in DNS yet) that used to rotate a healthy
  // tunnel on every reconcile.
  const net: TunnelNet & { probeUrl(url: string): Promise<boolean> } = {
    ...fakeDownload(ctx),
    async probeUrl(url: string) {
      probed.push(url);
      return false;
    },
  };
  const first = await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, net);
  // install.sh reconciles twice about five seconds apart (`cli install`, then
  // `cli tunnel on`); every later caller (UI save, guard repair) adds more.
  const second = await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, net);
  const third = await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, net);
  assert.equal(first.kind, "cloudflare-quick");
  assert.equal(second.kind, "cloudflare-quick");
  assert.equal(third.kind, "cloudflare-quick");
  if (first.kind !== "cloudflare-quick" || second.kind !== "cloudflare-quick" || third.kind !== "cloudflare-quick") {
    return;
  }
  assert.equal(second.url, first.url);
  assert.equal(third.url, first.url);
  assert.equal(second.pid, first.pid);
  assert.equal(ctx.started.length, 1, "a live pid is never restarted");
  assert.deepEqual(ctx.stopped, [], "a live pid is never stopped");
  assert.deepEqual(probed, [], "the public URL is never probed");
  assert.equal(eventRows(ctx).length, 1, "no rotation event is written");
});

test("a dead cloudflared is replaced, and only then does the URL rotate", async () => {
  const ctx = tunnelDeps(["https://openbot-old.trycloudflare.com", "https://openbot-new.trycloudflare.com"]);
  const first = await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, fakeDownload(ctx));
  assert.equal(first.kind, "cloudflare-quick");
  if (first.kind !== "cloudflare-quick") {
    return;
  }
  assert.equal(first.url, "https://openbot-old.trycloudflare.com");
  // The process died (crash, OOM kill, reboot) and left its pidfile and cache
  // behind. readTunnelCache answers off; the URL it recorded is still readable.
  ctx.kill(88);
  assert.deepEqual(readTunnelCache(ctx.deps), { kind: "off" });
  assert.equal(readCachedTunnelUrl(ctx.deps), "https://openbot-old.trycloudflare.com");

  const second = await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, fakeDownload(ctx));
  assert.equal(second.kind, "cloudflare-quick");
  if (second.kind !== "cloudflare-quick") {
    return;
  }
  assert.equal(second.url, "https://openbot-new.trycloudflare.com");
  assert.equal(second.pid, 89);
  assert.equal(ctx.started.length, 2);
  assert.deepEqual(ctx.stopped, [], "an already dead pid is not signalled");

  // The history is not erased: the old hostname is still in the log, the new
  // one was read from after this start's marker, and the events channel says
  // exactly what happened, from where, to where and why.
  const log = ctx.deps.fs.read(ctx.deps.paths.tunnelLog) ?? "";
  assert.match(log, /--- openbot: starting cloudflared \(pid-dead\), replacing https:\/\/openbot-old\.trycloudflare\.com/);
  assert.match(log, /openbot-old\.trycloudflare\.com/);
  assert.match(log, /openbot-new\.trycloudflare\.com/);
  const events = eventRows(ctx);
  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, "tunnel.rotate");
  assert.equal(events[1]?.severity, "WARN");
  assert.deepEqual(events[1]?.metadata, {
    reason: "pid-dead",
    url: "https://openbot-new.trycloudflare.com",
    pid: 89,
    previousUrl: "https://openbot-old.trycloudflare.com",
  });
});

test("an unreadable cache replaces the process that owns it", async () => {
  const ctx = tunnelDeps(["https://openbot-old.trycloudflare.com", "https://openbot-new.trycloudflare.com"]);
  const first = await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, fakeDownload(ctx));
  assert.equal(first.kind, "cloudflare-quick");
  // cloudflared is still alive but nothing records which hostname it booked.
  ctx.deps.fs.write(ctx.deps.paths.tunnelCache, "{ truncated");
  const second = await reconcileExpose({ kind: "cloudflare-quick" }, ctx.deps, fakeDownload(ctx));
  assert.equal(second.kind, "cloudflare-quick");
  if (second.kind !== "cloudflare-quick") {
    return;
  }
  assert.equal(second.url, "https://openbot-new.trycloudflare.com");
  assert.equal(ctx.started.length, 2);
  // The orphan is stopped, or it would hold an untracked hostname forever.
  assert.deepEqual(ctx.stopped, [88]);
  const events = eventRows(ctx);
  assert.equal(events[1]?.type, "tunnel.rotate");
  assert.equal(events[1]?.severity, "WARN");
  // Nothing recorded the old hostname, so the row says so instead of inventing
  // one: what changed, why, and what serves now.
  assert.deepEqual(events[1]?.metadata, {
    reason: "cache-unreadable",
    pid: 89,
    url: "https://openbot-new.trycloudflare.com",
  });
  assert.match(String(events[1]?.message), /the previous hostname was not recoverable/);
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
