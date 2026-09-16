import assert from "node:assert/strict";
import test from "node:test";
import { boxPathsFrom, joinAbs, type BoxPaths } from "./paths.ts";
import { type FsDeps, type ProcDeps, parseOwnedPid } from "./procs.ts";
import {
  GUARD_WATCH_BACKOFF_BASE_MS,
  GUARD_WATCH_BACKOFF_MAX_MS,
  GUARD_WATCH_HEARTBEAT_FILE,
  GUARD_WATCH_INTERVAL_MS,
  type GuardWatchEvent,
  type GuardWatchHeartbeat,
  type GuardWatchMode,
  type GuardWatchState,
  createGuardWatchState,
  decideGuardWatch,
  guardWatchBackoffMs,
  guardWatchHeartbeatPath,
  runGuardWatchTick,
} from "./guard-watch.ts";

const DAEMON_PID = 4242;

type Spawn = {
  readonly argv: readonly string[];
  readonly pidFile: string;
  readonly writePidFile: boolean;
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

/** A spawn that fails when the test says so; the daemon never publishes a pid. */
function setup(opts: { fail?: string } = {}) {
  const paths: BoxPaths = boxPathsFrom({
    repoRoot: "/tmp/openbot-watch-repo",
    sandData: "/tmp/openbot-watch-data",
    hostMain: "/tmp/openbot-watch-host/host-main.cjs",
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
      spawns.push({
        argv: [...input.argv],
        pidFile: String(input.pidFile),
        writePidFile: input.writePidFile !== false,
        log: String(input.log),
      });
      if (opts.fail !== undefined) {
        throw new Error(opts.fail);
      }
      if (input.writePidFile !== false) {
        fs.write(input.pidFile, `${String(DAEMON_PID)}\n`);
      }
      return parseOwnedPid(DAEMON_PID);
    },
    stop() {},
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

/** The daemon boots and publishes the pidfile runGuardDaemon writes itself. */
function daemonAppears(ctx: ReturnType<typeof setup>): void {
  ctx.fs.write(ctx.paths.guardPid, `${String(DAEMON_PID)}\n`);
  ctx.procs.live.add(DAEMON_PID);
}

function tick(
  ctx: ReturnType<typeof setup>,
  state: GuardWatchState,
  opts: { mode?: GuardWatchMode; nowMs?: number; events?: GuardWatchEvent[]; lines?: string[] } = {},
) {
  return runGuardWatchTick(ctx.deps, state, {
    mode: opts.mode ?? "custom",
    now: () => opts.nowMs ?? 0,
    event: (entry) => {
      opts.events?.push(entry);
    },
    log: (line) => {
      opts.lines?.push(line);
    },
  });
}

test("a custom box with no live guard starts the daemon install.sh would", () => {
  const ctx = setup();
  const state = createGuardWatchState();
  const events: GuardWatchEvent[] = [];
  const lines: string[] = [];
  const outcome = tick(ctx, state, { nowMs: 1_000_000, events, lines });
  assert.deepEqual(outcome, { kind: "started", pid: DAEMON_PID });
  assert.equal(ctx.procs.spawns.length, 1);
  assert.deepEqual(ctx.procs.spawns[0]?.argv, [
    "--experimental-strip-types",
    joinAbs(ctx.paths.repoRoot, "src/cli.ts"),
    "guard",
    "--daemon",
    "--host-main",
    ctx.paths.hostMain,
    "--sand-data",
    ctx.paths.sandData,
    // Explicit, like install.sh: a daemon restarted here must patrol at the
    // box's interval, not silently fall back to the CLI default.
    "--interval",
    "1",
  ]);
  // The daemon publishes this pidfile itself. Pre-writing the child's pid would
  // make the child read a live owner -- itself -- back and exit without
  // patrolling, and would clobber the lock a concurrently starting daemon
  // holds (install.sh starts one at the end of every install).
  assert.equal(ctx.procs.spawns[0]?.pidFile, String(ctx.paths.guardPid));
  assert.equal(ctx.procs.spawns[0]?.writePidFile, false);
  assert.equal(ctx.fs.read(ctx.paths.guardPid), undefined);
  // The daemon's stderr shares the service log; its structured rows stay in
  // openbot-guard.log, which must remain pure JSONL.
  assert.equal(ctx.procs.spawns[0]?.log, String(ctx.paths.uiLog));
  assert.deepEqual(events, [
    { type: "guard.watch", severity: "WARN", message: `Guard daemon was not running; started it (pid ${String(DAEMON_PID)}).` },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^openbot-guard-watch: Guard daemon was not running/);
  // Unconfirmed: the next check decides whether the start actually took.
  assert.equal(state.awaitingStart, true);
  assert.equal(state.failures, 0);
});

test("a persisted interval is passed through to the restarted daemon", () => {
  const ctx = setup();
  // The value install.sh honours too: a box tuned to a slower patrol must not
  // silently return to the default when the service restarts its daemon.
  ctx.fs.write(ctx.paths.guardInterval, "7\n");
  const outcome = tick(ctx, createGuardWatchState(), { nowMs: 0 });
  assert.equal(outcome.kind, "started");
  assert.deepEqual(ctx.procs.spawns[0]?.argv.slice(-2), ["--interval", "7"]);
});

test("OPENBOT_GUARD_INTERVAL wins over the persisted file", () => {
  const ctx = setup();
  ctx.fs.write(ctx.paths.guardInterval, "7\n");
  const saved = process.env.OPENBOT_GUARD_INTERVAL;
  process.env.OPENBOT_GUARD_INTERVAL = "3";
  try {
    const outcome = tick(ctx, createGuardWatchState(), { nowMs: 0 });
    assert.equal(outcome.kind, "started");
    assert.deepEqual(ctx.procs.spawns[0]?.argv.slice(-2), ["--interval", "3"]);
  } finally {
    if (saved === undefined) {
      delete process.env.OPENBOT_GUARD_INTERVAL;
    } else {
      process.env.OPENBOT_GUARD_INTERVAL = saved;
    }
  }
});

test("a start that has not been confirmed yet is never repeated", () => {
  const ctx = setup();
  const state = createGuardWatchState();
  const events: GuardWatchEvent[] = [];
  assert.equal(tick(ctx, state, { nowMs: 0, events }).kind, "started");
  assert.equal(ctx.procs.spawns.length, 1);
  // One full interval later the daemon still has not published a pid: that is
  // the single-flight rule -- one start in flight, no second spawn until the
  // first is accounted for.
  const second = tick(ctx, state, { nowMs: GUARD_WATCH_INTERVAL_MS, events });
  assert.deepEqual(second, { kind: "skipped", reason: "backoff", retryInMs: GUARD_WATCH_BACKOFF_BASE_MS });
  assert.equal(ctx.procs.spawns.length, 1);
  assert.equal(state.failures, 1);
  assert.equal(events.at(-1)?.severity, "WARN");
  assert.match(events.at(-1)?.message ?? "", /did not come up after a start \(attempt 1\); retrying in 60s/);
});

test("a live daemon is a no-op", () => {
  const ctx = setup();
  const state = createGuardWatchState();
  const events: GuardWatchEvent[] = [];
  daemonAppears(ctx);
  const outcome = tick(ctx, state, { nowMs: 0, events });
  assert.deepEqual(outcome, { kind: "skipped", reason: "running" });
  assert.equal(ctx.procs.spawns.length, 0);
  assert.deepEqual(events, []);
  assert.equal(state.failures, 0);
});

test("official never starts a guard, whatever the pidfile says", () => {
  const ctx = setup();
  const state = createGuardWatchState();
  state.failures = 3;
  state.notBeforeMs = 999_999;
  for (const nowMs of [0, GUARD_WATCH_INTERVAL_MS, 2 * GUARD_WATCH_INTERVAL_MS]) {
    assert.deepEqual(tick(ctx, state, { mode: "official", nowMs }), { kind: "skipped", reason: "official" });
  }
  assert.equal(ctx.procs.spawns.length, 0);
  // Coming back to custom starts from a clean slate, not a stale cooldown.
  assert.equal(state.failures, 0);
  assert.equal(state.notBeforeMs, 0);
});

test("a spawn that throws is reported and cooled down, not retried in a loop", () => {
  const ctx = setup({ fail: "spawn ENOENT" });
  const state = createGuardWatchState();
  const events: GuardWatchEvent[] = [];
  assert.deepEqual(tick(ctx, state, { nowMs: 0, events }), { kind: "failed", message: "spawn ENOENT" });
  assert.equal(ctx.procs.spawns.length, 1);
  assert.equal(state.failures, 1);
  assert.equal(state.awaitingStart, false);
  assert.match(events.at(-1)?.message ?? "", /Could not start the guard daemon: spawn ENOENT \(attempt 1\); retrying in 60s/);
  // Halfway into the cooldown: nothing.
  assert.deepEqual(tick(ctx, state, { nowMs: 30_000, events }), {
    kind: "skipped",
    reason: "backoff",
    retryInMs: 30_000,
  });
  assert.equal(ctx.procs.spawns.length, 1);
});

test("repeated failures double the wait up to the ceiling", () => {
  const ctx = setup();
  const state = createGuardWatchState();
  const spawnTimes: number[] = [];
  let nowMs = 0;
  // An hour of one-minute checks against a start that can never work.
  for (let i = 0; i <= 60; i += 1) {
    const before = ctx.procs.spawns.length;
    tick(ctx, state, { nowMs });
    if (ctx.procs.spawns.length > before) {
      spawnTimes.push(nowMs);
    }
    nowMs += GUARD_WATCH_INTERVAL_MS;
  }
  // 7 attempts, not 60: 60s, then 2m, 4m, 8m, and the 15m ceiling. The gap
  // after attempt N is measured from the check that books it as failed.
  assert.deepEqual(spawnTimes, [0, 120_000, 300_000, 600_000, 1_140_000, 2_100_000, 3_060_000]);
  assert.equal(state.failures, 7);
  assert.equal(
    spawnTimes.every((time, index) => index === 0 || time - (spawnTimes[index - 1] ?? 0) >= GUARD_WATCH_INTERVAL_MS),
    true,
  );
});

test("a daemon that comes back resets the streak and says so", () => {
  const ctx = setup({ fail: "no node" });
  const state = createGuardWatchState();
  const events: GuardWatchEvent[] = [];
  tick(ctx, state, { nowMs: 0, events });
  assert.equal(state.failures, 1);
  // Out of band: someone started the guard again (or the first spawn finally
  // landed). The next check sees it and stops counting.
  daemonAppears(ctx);
  assert.deepEqual(tick(ctx, state, { nowMs: 60_000, events }), { kind: "skipped", reason: "running" });
  assert.equal(state.failures, 0);
  assert.equal(state.notBeforeMs, 0);
  assert.deepEqual(events.at(-1), {
    type: "guard.watch",
    severity: "INFO",
    message: `Guard daemon is running again (pid ${String(DAEMON_PID)}) after 1 failed start(s).`,
  });
});

test("decideGuardWatch carries the whole policy on its own", () => {
  const fresh = createGuardWatchState();
  assert.deepEqual(decideGuardWatch({ mode: "custom", runningPid: DAEMON_PID, state: fresh, nowMs: 0 }), {
    kind: "skip",
    reason: "running",
  });
  assert.deepEqual(decideGuardWatch({ mode: "official", runningPid: undefined, state: fresh, nowMs: 0 }), {
    kind: "skip",
    reason: "official",
  });
  assert.deepEqual(
    decideGuardWatch({ mode: "custom", runningPid: undefined, state: { ...fresh, starting: true }, nowMs: 0 }),
    { kind: "skip", reason: "starting" },
  );
  assert.deepEqual(
    decideGuardWatch({ mode: "custom", runningPid: undefined, state: { ...fresh, awaitingStart: true }, nowMs: 0 }),
    { kind: "skip", reason: "awaiting-start" },
  );
  assert.deepEqual(
    decideGuardWatch({ mode: "custom", runningPid: undefined, state: { ...fresh, notBeforeMs: 500 }, nowMs: 200 }),
    { kind: "skip", reason: "backoff", retryInMs: 300 },
  );
  assert.deepEqual(decideGuardWatch({ mode: "custom", runningPid: undefined, state: fresh, nowMs: 0 }), {
    kind: "start",
  });
});

test("the cooldown starts at one check interval and is capped", () => {
  // A cooldown shorter than the check interval is not a cooldown: the next
  // check would already be past it.
  assert.equal(GUARD_WATCH_BACKOFF_BASE_MS, GUARD_WATCH_INTERVAL_MS);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 9].map((failures) => guardWatchBackoffMs(failures)),
    [60_000, 60_000, 120_000, 240_000, 480_000, GUARD_WATCH_BACKOFF_MAX_MS, GUARD_WATCH_BACKOFF_MAX_MS],
  );
  assert.equal(GUARD_WATCH_BACKOFF_MAX_MS, 15 * 60_000);
});

// ---- Liveness heartbeat. The events above only exist when the babysitter
// acts, so a dead babysitter and a quiet one look identical from outside. The
// heartbeat file is rewritten on every tick, quiet ticks included.

function heartbeat(ctx: ReturnType<typeof setup>): GuardWatchHeartbeat | undefined {
  const raw = ctx.fs.read(guardWatchHeartbeatPath(ctx.deps));
  return raw === undefined ? undefined : (JSON.parse(raw) as GuardWatchHeartbeat);
}

test("a quiet tick still proves the babysitter is alive", () => {
  const ctx = setup();
  const state = createGuardWatchState();
  daemonAppears(ctx);
  const nowMs = 1_700_000_000_000;
  // The tick that used to leave no trace at all: the daemon is running, so
  // there is nothing to start and no event to write.
  assert.deepEqual(tick(ctx, state, { nowMs }), { kind: "skipped", reason: "running" });
  assert.equal(guardWatchHeartbeatPath(ctx.deps), joinAbs(ctx.paths.sandData, GUARD_WATCH_HEARTBEAT_FILE));
  assert.deepEqual(heartbeat(ctx), {
    lastTickAt: new Date(nowMs).toISOString(),
    lastTickMs: nowMs,
    mode: "custom",
    guardPid: DAEMON_PID,
    lastAction: "skip:running",
    failures: 0,
  });
});

test("starts, failures, and official ticks all refresh the heartbeat", () => {
  const ctx = setup();
  const state = createGuardWatchState();
  // A start: the spawned pid is not in the pidfile yet, so the heartbeat
  // reports the pid the tick found (none) and says what it did.
  assert.equal(tick(ctx, state, { nowMs: 1_000 }).kind, "started");
  assert.deepEqual(heartbeat(ctx), {
    lastTickAt: new Date(1_000).toISOString(),
    lastTickMs: 1_000,
    mode: "custom",
    guardPid: null,
    lastAction: `started:${String(DAEMON_PID)}`,
    failures: 0,
  });
  // The next check books the unconfirmed start as a failure.
  const failed = tick(ctx, state, { nowMs: 61_000 });
  assert.equal(failed.kind, "skipped");
  assert.equal(heartbeat(ctx)?.failures, 1);
  assert.equal(heartbeat(ctx)?.lastAction, "skip:backoff");
  // Official keeps nothing alive, and still rewrites the file.
  tick(ctx, state, { mode: "official", nowMs: 121_000 });
  assert.deepEqual(heartbeat(ctx), {
    lastTickAt: new Date(121_000).toISOString(),
    lastTickMs: 121_000,
    mode: "official",
    guardPid: null,
    lastAction: "skip:official",
    failures: 0,
  });
});

test("a heartbeat write that fails never breaks the tick", () => {
  const ctx = setup();
  ctx.fs.write = () => {
    throw new Error("EROFS: read-only file system");
  };
  const state = createGuardWatchState();
  // The start still happens and is still reported.
  const events: GuardWatchEvent[] = [];
  assert.deepEqual(tick(ctx, state, { nowMs: 0, events }), { kind: "started", pid: DAEMON_PID });
  assert.equal(ctx.procs.spawns.length, 1);
  assert.equal(events.length, 1);
});
