import assert from "node:assert/strict";
import test from "node:test";
import { type AbsPath, type Expose } from "../domain/types.ts";
import { boxPathsFrom, type BoxPaths } from "./paths.ts";
import { type FsDeps, type ProcDeps, parseOwnedPid } from "./procs.ts";
import { readTunnelCache } from "./tunnel.ts";
import {
  TUNNEL_WATCH_BACKOFF_BASE_MS,
  TUNNEL_WATCH_BACKOFF_MAX_MS,
  TUNNEL_WATCH_INTERVAL_MS,
  type TunnelWatchEvent,
  type TunnelWatchMode,
  type TunnelWatchState,
  createTunnelWatchState,
  decideTunnelWatch,
  runTunnelWatchTick,
  tunnelWatchBackoffMs,
} from "./tunnel-watch.ts";

const TUNNEL_PID = 4242;

type Spawn = {
  readonly argv: readonly string[];
  readonly pidFile: string;
  readonly log: string;
};

type FakeProcs = ProcDeps & { spawns: Spawn[]; live: Set<number> };

function memoryFs(): FsDeps & { files: Record<string, string> } {
  const files: Record<string, string> = {};
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

/** A spawn that fails when the test says so; otherwise it books a URL. */
function setup(opts: { fail?: string } = {}) {
  const paths: BoxPaths = boxPathsFrom({
    repoRoot: "/tmp/openbot-tunnel-watch-repo",
    sandData: "/tmp/openbot-tunnel-watch-data",
    hostMain: "/tmp/openbot-tunnel-watch-host/host-main.cjs",
  });
  const fs = memoryFs();
  const spawns: Spawn[] = [];
  const live = new Set<number>();
  const procs: FakeProcs = {
    spawns,
    live,
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
      spawns.push({ argv: [...input.argv], pidFile: String(input.pidFile), log: String(input.log) });
      if (opts.fail !== undefined) {
        throw new Error(opts.fail);
      }
      // cloudflared appends its banner and the hostname to its own log.
      const previous = fs.read(input.log) ?? "";
      fs.write(input.log, `${previous}INF |  https://openbot-watch.trycloudflare.com |\n`);
      fs.write(input.pidFile, `${String(TUNNEL_PID)}\n`);
      live.add(TUNNEL_PID);
      return parseOwnedPid(TUNNEL_PID);
    },
    stop(pid) {
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
  return { deps: { paths, fs, procs }, fs, procs, paths };
}

/** The cloudflared process dies without any cleanup: pidfile and cache stay. */
function tunnelDies(ctx: ReturnType<typeof setup>): void {
  ctx.procs.live.clear();
}

function tick(
  ctx: ReturnType<typeof setup>,
  state: TunnelWatchState,
  opts: { mode?: TunnelWatchMode; expose?: Expose; nowMs?: number; events?: TunnelWatchEvent[]; lines?: string[] } = {},
) {
  return runTunnelWatchTick(ctx.deps, state, {
    mode: opts.mode ?? "custom",
    expose: opts.expose ?? { kind: "cloudflare-quick" },
    now: () => opts.nowMs ?? 0,
    event: (entry) => {
      opts.events?.push(entry);
    },
    log: (line) => {
      opts.lines?.push(line);
    },
    net: {
      async download(_url: string, dest: AbsPath) {
        ctx.fs.write(dest, "fake-cloudflared\n");
      },
    },
  });
}

test("a cloudflared that died is restarted and reported", async () => {
  const ctx = setup();
  const state = createTunnelWatchState();
  const events: TunnelWatchEvent[] = [];
  const lines: string[] = [];
  const outcome = await tick(ctx, state, { nowMs: 1_000_000, events, lines });
  assert.deepEqual(outcome, { kind: "started", url: "https://openbot-watch.trycloudflare.com", pid: TUNNEL_PID });
  assert.equal(ctx.procs.spawns.length, 1);
  assert.deepEqual(ctx.procs.spawns[0]?.argv, ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:9280"]);
  assert.equal(ctx.procs.spawns[0]?.pidFile, String(ctx.paths.tunnelPid));
  // The cache is what makes the next check a no-op, so it must be written.
  assert.match(ctx.fs.read(ctx.paths.tunnelCache) ?? "", /openbot-watch\.trycloudflare\.com/);
  assert.deepEqual(events, [
    {
      type: "tunnel.watch",
      severity: "WARN",
      message: `Cloudflare Tunnel was down; cloudflared is up again and published https://openbot-watch.trycloudflare.com (pid ${String(TUNNEL_PID)}).`,
    },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^openbot-tunnel-watch: Cloudflare Tunnel was down/);
  assert.equal(state.starting, false, "the re-entry latch is always released");
  assert.equal(state.failures, 0);
});

test("a live tunnel is a no-op", async () => {
  const ctx = setup();
  const state = createTunnelWatchState();
  const events: TunnelWatchEvent[] = [];
  await tick(ctx, state, { nowMs: 0, events });
  assert.equal(ctx.procs.spawns.length, 1);
  events.length = 0;
  const outcome = await tick(ctx, state, { nowMs: TUNNEL_WATCH_INTERVAL_MS, events });
  assert.deepEqual(outcome, { kind: "skipped", reason: "running" });
  assert.equal(ctx.procs.spawns.length, 1, "a live pid is never started again");
  assert.deepEqual(events, [], "a healthy tunnel is not reported");
  assert.equal(state.failures, 0);
});

test("official never starts a tunnel, whatever the expose file says", async () => {
  const ctx = setup();
  const state = createTunnelWatchState();
  state.failures = 3;
  state.notBeforeMs = 999_999;
  for (const nowMs of [0, TUNNEL_WATCH_INTERVAL_MS, 2 * TUNNEL_WATCH_INTERVAL_MS]) {
    assert.deepEqual(await tick(ctx, state, { mode: "official", nowMs }), { kind: "skipped", reason: "official" });
  }
  assert.equal(ctx.procs.spawns.length, 0);
  // Coming back to custom starts from a clean slate, not a stale cooldown.
  assert.equal(state.failures, 0);
  assert.equal(state.notBeforeMs, 0);
});

test("a loopback expose is left alone", async () => {
  const ctx = setup();
  const state = createTunnelWatchState();
  state.failures = 2;
  const outcome = await tick(ctx, state, { expose: { kind: "loopback" }, nowMs: 0 });
  assert.deepEqual(outcome, { kind: "skipped", reason: "loopback" });
  assert.equal(ctx.procs.spawns.length, 0);
  assert.equal(state.failures, 0);
});

test("a start that is still in flight is never repeated", async () => {
  const ctx = setup();
  const state = createTunnelWatchState();
  state.starting = true;
  assert.deepEqual(await tick(ctx, state, { nowMs: 0 }), { kind: "skipped", reason: "starting" });
  assert.equal(ctx.procs.spawns.length, 0);
});

test("a spawn that throws is reported and cooled down, not retried in a loop", async () => {
  const ctx = setup({ fail: "spawn ENOENT" });
  const state = createTunnelWatchState();
  const events: TunnelWatchEvent[] = [];
  assert.deepEqual(await tick(ctx, state, { nowMs: 0, events }), { kind: "failed", message: "spawn ENOENT" });
  assert.equal(ctx.procs.spawns.length, 1);
  assert.equal(state.failures, 1);
  assert.equal(state.starting, false);
  assert.match(
    events.at(-1)?.message ?? "",
    /Could not restart cloudflared: spawn ENOENT \(attempt 1\); retrying in 60s/,
  );
  // Halfway into the cooldown: nothing.
  assert.deepEqual(await tick(ctx, state, { nowMs: 30_000, events }), {
    kind: "skipped",
    reason: "backoff",
    retryInMs: 30_000,
  });
  assert.equal(ctx.procs.spawns.length, 1);
});

test("repeated failures double the wait up to the ceiling", async () => {
  const ctx = setup({ fail: "no cloudflared" });
  const state = createTunnelWatchState();
  const spawnTimes: number[] = [];
  let nowMs = 0;
  // An hour of one-minute checks against a start that can never work.
  for (let i = 0; i <= 60; i += 1) {
    const before = ctx.procs.spawns.length;
    await tick(ctx, state, { nowMs });
    if (ctx.procs.spawns.length > before) {
      spawnTimes.push(nowMs);
    }
    nowMs += TUNNEL_WATCH_INTERVAL_MS;
  }
  // 8 attempts, not 60: the failure is booked inside the same tick, so the
  // gaps are 60s, then 2m, 4m, 8m and the 15m ceiling.
  assert.deepEqual(spawnTimes, [0, 60_000, 180_000, 420_000, 900_000, 1_800_000, 2_700_000, 3_600_000]);
  assert.equal(state.failures, 8);
});

test("a start that heals the streak resets it", async () => {
  const broken = setup({ fail: "no cloudflared" });
  const state = createTunnelWatchState();
  await tick(broken, state, { nowMs: 0 });
  assert.equal(state.failures, 1);
  assert.equal(state.notBeforeMs, TUNNEL_WATCH_BACKOFF_BASE_MS);
  // The next attempt works (cloudflared was downloaded in the meantime): the
  // cooldown is over, the start lands, and the streak is forgotten.
  const ctx = setup();
  assert.equal((await tick(ctx, state, { nowMs: TUNNEL_WATCH_BACKOFF_BASE_MS })).kind, "started");
  assert.equal(state.failures, 0);
  assert.equal(state.notBeforeMs, 0);
});

test("a tunnel found running after failures resets the streak and says so", async () => {
  const ctx = setup();
  const state = createTunnelWatchState();
  // Out of band: someone ran `openbot tunnel on`, or the earlier spawn landed.
  ctx.fs.write(ctx.paths.tunnelPid, `${String(TUNNEL_PID)}\n`);
  ctx.procs.live.add(TUNNEL_PID);
  ctx.fs.write(
    ctx.paths.tunnelCache,
    `${JSON.stringify({
      kind: "cloudflare-quick",
      url: "https://out-of-band.trycloudflare.com",
      internal: "http://127.0.0.1:9280",
      pid: TUNNEL_PID,
    })}\n`,
  );
  state.failures = 2;
  state.notBeforeMs = 999_999;
  const events: TunnelWatchEvent[] = [];
  assert.deepEqual(await tick(ctx, state, { nowMs: 0, events }), { kind: "skipped", reason: "running" });
  assert.equal(ctx.procs.spawns.length, 0);
  assert.equal(state.failures, 0);
  assert.equal(state.notBeforeMs, 0);
  assert.deepEqual(events, [
    {
      type: "tunnel.watch",
      severity: "INFO",
      message: "Cloudflare Tunnel is serving again (https://out-of-band.trycloudflare.com) after 2 failed restart(s).",
    },
  ]);
});

test("the cache is the liveness test: a dead pid is restarted, a live one is not", async () => {
  const ctx = setup();
  const state = createTunnelWatchState();
  await tick(ctx, state, { nowMs: 0 });
  assert.equal(readTunnelCache(ctx.deps).kind, "cloudflare-quick");
  tunnelDies(ctx);
  assert.deepEqual(readTunnelCache(ctx.deps), { kind: "off" });
  const restarted = await tick(ctx, state, { nowMs: 60_000 });
  assert.equal(restarted.kind, "started");
  assert.equal(ctx.procs.spawns.length, 2);
});

test("decideTunnelWatch carries the whole policy on its own", () => {
  const fresh = createTunnelWatchState();
  const quick: Expose = { kind: "cloudflare-quick" };
  assert.deepEqual(
    decideTunnelWatch({ mode: "official", expose: quick, running: false, state: fresh, nowMs: 0 }),
    { kind: "skip", reason: "official" },
  );
  assert.deepEqual(
    decideTunnelWatch({ mode: "custom", expose: { kind: "loopback" }, running: false, state: fresh, nowMs: 0 }),
    { kind: "skip", reason: "loopback" },
  );
  assert.deepEqual(decideTunnelWatch({ mode: "custom", expose: quick, running: true, state: fresh, nowMs: 0 }), {
    kind: "skip",
    reason: "running",
  });
  assert.deepEqual(
    decideTunnelWatch({ mode: "custom", expose: quick, running: false, state: { ...fresh, starting: true }, nowMs: 0 }),
    { kind: "skip", reason: "starting" },
  );
  assert.deepEqual(
    decideTunnelWatch({
      mode: "custom",
      expose: quick,
      running: false,
      state: { ...fresh, notBeforeMs: 500 },
      nowMs: 200,
    }),
    { kind: "skip", reason: "backoff", retryInMs: 300 },
  );
  assert.deepEqual(decideTunnelWatch({ mode: "custom", expose: quick, running: false, state: fresh, nowMs: 0 }), {
    kind: "start",
  });
});

test("the cooldown starts at one check interval and is capped", () => {
  // A cooldown shorter than the check interval is not a cooldown: the next
  // check would already be past it.
  assert.equal(TUNNEL_WATCH_BACKOFF_BASE_MS, TUNNEL_WATCH_INTERVAL_MS);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 9].map((failures) => tunnelWatchBackoffMs(failures)),
    [60_000, 60_000, 120_000, 240_000, 480_000, TUNNEL_WATCH_BACKOFF_MAX_MS, TUNNEL_WATCH_BACKOFF_MAX_MS],
  );
  assert.equal(TUNNEL_WATCH_BACKOFF_MAX_MS, 15 * 60_000);
});
