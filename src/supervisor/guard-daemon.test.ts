import assert from "node:assert/strict";
import test from "node:test";
import { OPENBOT_MARKER } from "../domain/types.ts";
import { customBoxFromProvider, parseInstallCommand, parseUpstreamOrigin } from "../parse/argv.ts";
import { type FsDeps, type ProcDeps, parseOwnedPid } from "./procs.ts";
import { boxPathsFrom, joinAbs, type BoxPaths } from "./paths.ts";
import {
  DEFAULT_GUARD_INTERVAL_MINUTES,
  GUARD_BOUNCE_GRACE_TICKS,
  GUARD_DAEMON_SOURCE,
  GUARD_LOG_MAX_BYTES,
  type GuardDaemonOutcome,
  type GuardLogRow,
  appendGuardLogLine,
  guardDaemonPid,
  readPersistedGuardInterval,
  resolveGuardIntervalMinutes,
  runGuardDaemon,
  runGuardTick,
  runGuardTickWithHopHealth,
  startGuardDaemon,
  stopGuardDaemon,
} from "./guard-daemon.ts";
import { guardCustom, type GuardResult } from "./guard.ts";
import { compileCustomPlan, planToJson } from "./plan.ts";
import { payloadFingerprint } from "../host/payload-fingerprint.ts";
import { armDeferredHostBounce } from "./reconcile.ts";

function guardResult(overrides: Partial<GuardResult>): GuardResult {
  return {
    modeRepaired: false,
    wrapRepaired: false,
    ok: true,
    detail: "healthy",
    reconcile: undefined,
    ...overrides,
  };
}

const HEALTHY = guardResult({});
const REPAIRED_BOTH = guardResult({ detail: "repaired", modeRepaired: true, wrapRepaired: true });
const REPAIRED_MODE = guardResult({ detail: "repaired", modeRepaired: true });
const REPAIRED_WRAP = guardResult({ detail: "repaired", wrapRepaired: true });
const REFUSED = guardResult({ detail: "refused", ok: false, reconcile: { kind: "refused", error: { kind: "foreign-hop" } } });
const NO_CUSTOM = guardResult({ detail: "no-custom-state", ok: false });

type FakeProcs = ProcDeps & { stopped: number[]; live: Set<number>; hopPortOpen?: boolean };

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

function fakeProcs(fs: ReturnType<typeof memoryFs>, hopPortOpen = false): FakeProcs {
  const live = new Set<number>();
  const stopped: number[] = [];
  return {
    live,
    stopped,
    hopPortOpen,
    async port() {
      if (String(arguments[1]) === "9280") {
        return this.hopPortOpen === true;
      }
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
      return pid === process.pid || live.has(pid);
    },
    start(input) {
      fs.write(input.pidFile, "1\n");
      live.add(1);
      return parseOwnedPid(1);
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
    term(pid) {
      stopped.push(pid);
      live.delete(pid);
    },
    syntaxCheck() {
      return { ok: true };
    },
  };
}

function setup(hopPortOpen = false) {
  const paths: BoxPaths = boxPathsFrom({
    repoRoot: "/tmp/openbot-guard-repo",
    sandData: "/tmp/openbot-guard-data",
    hostMain: "/tmp/openbot-guard-host/host-main.cjs",
  });
  const fs = memoryFs();
  const procs = fakeProcs(fs, hopPortOpen);
  return { deps: { paths, fs, procs }, fs, procs, paths };
}

type AuditRow = { ts: string; action: string; from: string; to: string; source: string };

function auditRows(ctx: ReturnType<typeof setup>): AuditRow[] {
  const raw = ctx.fs.read(joinAbs(ctx.paths.sandData, "openbot-audit.jsonl")) ?? "";
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AuditRow);
}

function guardLogRows(ctx: ReturnType<typeof setup>): GuardLogRow[] {
  const raw = ctx.fs.read(ctx.paths.guardLog) ?? "";
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as GuardLogRow);
}

type Counter = { calls: number };

function countingRunOnce(results: readonly GuardResult[]): {
  runOnce: () => Promise<GuardResult>;
  counter: Counter;
} {
  const counter: Counter = { calls: 0 };
  return {
    counter,
    runOnce: async () => {
      const result = results[Math.min(counter.calls, results.length - 1)];
      counter.calls += 1;
      if (result === undefined) {
        throw new Error("no scripted guard result");
      }
      return result;
    },
  };
}


/** The daemon loop is pure microtasks between timer fires, so a bounded
 * microtask drain settles each tick deterministically under mock timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
  }
}

test("daemon runs one tick immediately and then one per interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = setup();
  const { runOnce, counter } = countingRunOnce([HEALTHY]);
  const controller = new AbortController();
  const run = runGuardDaemon(ctx.deps, { intervalMinutes: 5, signal: controller.signal, runOnce });
  await flush();
  assert.equal(counter.calls, 1);
  t.mock.timers.tick(5 * 60_000);
  await flush();
  assert.equal(counter.calls, 2);
  t.mock.timers.tick(5 * 60_000 - 1);
  await flush();
  assert.equal(counter.calls, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(counter.calls, 3);
  controller.abort();
  const outcome: GuardDaemonOutcome = await run;
  assert.deepEqual(outcome, { kind: "stopped" });
  assert.equal(ctx.fs.read(ctx.paths.guardPid), undefined);
});

test("daemon writes its pid and releases it on shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = setup();
  const controller = new AbortController();
  const run = runGuardDaemon(ctx.deps, {
    intervalMinutes: DEFAULT_GUARD_INTERVAL_MINUTES,
    signal: controller.signal,
    runOnce: async () => HEALTHY,
    hopHealth: false,
  });
  await flush();
  assert.equal(ctx.fs.read(ctx.paths.guardPid), `${process.pid}\n`);
  assert.equal(guardDaemonPid(ctx.deps), process.pid);
  controller.abort();
  await run;
  assert.equal(ctx.fs.read(ctx.paths.guardPid), undefined);
  assert.equal(guardDaemonPid(ctx.deps), undefined);
});

test("repaired tick writes one audit line with the daemon source plus a guard log line", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = setup();
  const stderr: string[] = [];
  const controller = new AbortController();
  const run = runGuardDaemon(ctx.deps, {
    intervalMinutes: DEFAULT_GUARD_INTERVAL_MINUTES,
    signal: controller.signal,
    runOnce: async () => REPAIRED_BOTH,
    stderr: (line) => stderr.push(line),
    hopHealth: false,
  });
  await flush();
  controller.abort();
  await run;
  const rows = auditRows(ctx);
  assert.deepEqual(rows, [{ ts: rows[0]?.ts, action: "guard", from: "mode-drift+wrap-drift", to: "custom", source: "guard-daemon" }]);
  const logRows = guardLogRows(ctx);
  assert.equal(logRows.length, 1);
  assert.equal(logRows[0]?.detail, "repaired");
  assert.equal(logRows[0]?.ok, true);
  assert.equal(logRows[0]?.modeRepaired, true);
  assert.equal(logRows[0]?.wrapRepaired, true);
  assert.equal(stderr.length, 0);
});

test("a mode-only repair names the drift it repaired", async () => {
  const ctx = setup();
  await runGuardTick(ctx.deps, { runOnce: async () => REPAIRED_MODE, stderr: () => {} });
  const rows = auditRows(ctx);
  assert.deepEqual(
    rows.map((row) => [row.action, row.from, row.to, row.source]),
    [["guard", "mode-drift", "custom", "guard-daemon"]],
  );
});

test("refused and no-custom-state ticks log to stderr and keep looping", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = setup();
  const stderr: string[] = [];
  const { runOnce, counter } = countingRunOnce([REFUSED, NO_CUSTOM, HEALTHY]);
  const controller = new AbortController();
  const run = runGuardDaemon(ctx.deps, {
    intervalMinutes: DEFAULT_GUARD_INTERVAL_MINUTES,
    signal: controller.signal,
    runOnce,
    stderr: (line) => stderr.push(line),
    hopHealth: false,
  });
  await flush();
  t.mock.timers.tick(5 * 60_000);
  await flush();
  t.mock.timers.tick(5 * 60_000);
  await flush();
  assert.equal(counter.calls, 3);
  controller.abort();
  await run;
  assert.match(stderr[0] ?? "", /refused/);
  assert.match(stderr[1] ?? "", /no-custom-state/);
  assert.equal(stderr.length, 2);
  assert.deepEqual(auditRows(ctx), []);
  assert.deepEqual(
    guardLogRows(ctx).map((row) => row.detail),
    ["refused", "no-custom-state", "healthy"],
  );
});

test("a failing tick is logged and the loop keeps going", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = setup();
  const stderr: string[] = [];
  const counter: Counter = { calls: 0 };
  const controller = new AbortController();
  const run = runGuardDaemon(ctx.deps, {
    intervalMinutes: DEFAULT_GUARD_INTERVAL_MINUTES,
    signal: controller.signal,
    runOnce: async () => {
      counter.calls += 1;
      if (counter.calls === 1) {
        throw new Error("disk gone");
      }
      return HEALTHY;
    },
    stderr: (line) => stderr.push(line),
    hopHealth: false,
  });
  await flush();
  t.mock.timers.tick(5 * 60_000);
  await flush();
  assert.equal(counter.calls, 2);
  controller.abort();
  await run;
  assert.match(stderr[0] ?? "", /tick failed: disk gone/);
  assert.deepEqual(
    guardLogRows(ctx).map((row) => row.detail),
    ["error", "healthy"],
  );
});

test("the guard log truncates when it grows past the size cap", async () => {
  const ctx = setup();
  appendGuardLogLine(ctx.deps, { detail: "old", ok: true, modeRepaired: false, wrapRepaired: false });
  ctx.fs.write(ctx.paths.guardLog, "x".repeat(GUARD_LOG_MAX_BYTES + 1));
  await runGuardTick(ctx.deps, { runOnce: async () => HEALTHY, stderr: () => {} });
  const body = ctx.fs.read(ctx.paths.guardLog) ?? "";
  assert.equal(body.length <= GUARD_LOG_MAX_BYTES, true);
  const rows = guardLogRows(ctx);
  assert.deepEqual(
    rows.map((row) => row.detail),
    ["healthy"],
  );
});

test("stop SIGTERMs the pid from the pidfile and clears it", () => {
  const ctx = setup();
  assert.equal(stopGuardDaemon(ctx.deps), false);
  ctx.fs.write(ctx.paths.guardPid, "4242\n");
  ctx.procs.live.add(4242);
  assert.equal(stopGuardDaemon(ctx.deps), true);
  assert.deepEqual(ctx.procs.stopped, [4242]);
  assert.equal(ctx.fs.read(ctx.paths.guardPid), undefined);
});

test("a live pidfile lock prevents a second daemon", () => {
  const ctx = setup();
  ctx.fs.write(ctx.paths.guardPid, `${process.pid}\n`);
  ctx.procs.live.add(process.pid);
  const { counter } = countingRunOnce([HEALTHY]);
  return runGuardDaemon(ctx.deps, {
    intervalMinutes: DEFAULT_GUARD_INTERVAL_MINUTES,
    runOnce: async () => {
      counter.calls += 1;
      return HEALTHY;
    },
  }).then((outcome) => {
    assert.deepEqual(outcome, { kind: "already-running", pid: process.pid });
    assert.equal(counter.calls, 0);
    assert.equal(ctx.fs.read(ctx.paths.guardPid), `${process.pid}\n`);
  });
});

test("a stale pidfile from a dead process does not block a start", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = setup();
  ctx.fs.write(ctx.paths.guardPid, "999999\n");
  const { runOnce, counter } = countingRunOnce([HEALTHY]);
  const controller = new AbortController();
  const run = runGuardDaemon(ctx.deps, {
    intervalMinutes: DEFAULT_GUARD_INTERVAL_MINUTES,
    signal: controller.signal,
    runOnce,
    hopHealth: false,
  });
  await flush();
  assert.equal(counter.calls, 1);
  assert.equal(ctx.fs.read(ctx.paths.guardPid), `${process.pid}\n`);
  controller.abort();
  await run;
  assert.equal(ctx.fs.read(ctx.paths.guardPid), undefined);
});

test("guard parses daemon, stop, and interval flags", () => {
  const parse = (argv: string[]) => {
    const parsed = parseInstallCommand({ argv, env: {}, repoRoot: "/tmp/openbot" });
    if (parsed.command.kind !== "guard") {
      throw new Error(`expected guard, got ${parsed.command.kind}`);
    }
    return parsed.command;
  };
  assert.deepEqual(parse(["guard"]), { kind: "guard", action: "once", intervalMinutes: 1 });
  assert.deepEqual(parse(["guard", "--daemon"]), { kind: "guard", action: "daemon", intervalMinutes: 1 });
  assert.deepEqual(parse(["guard", "--stop"]), { kind: "guard", action: "stop", intervalMinutes: 1 });
  assert.equal(parse(["guard", "--daemon", "--interval", "1"]).intervalMinutes, 1);
  assert.equal(parse(["guard", "--daemon", "--interval", "0"]).intervalMinutes, 1);
  assert.equal(parse(["guard", "--daemon", "--interval", "100"]).intervalMinutes, 60);
  assert.equal(parse(["guard", "--daemon", "--interval", "7"]).intervalMinutes, 7);
  assert.equal(parse(["guard", "--daemon", "--json"]).intervalMinutes, 1);
});

test("the guard interval resolves env first, then the persisted file, then the default", () => {
  const ctx = setup();
  assert.equal(DEFAULT_GUARD_INTERVAL_MINUTES, 1);
  // Nothing recorded anywhere: the default. A patrol reads two files, so the
  // five-minute window it replaces was pure drift time.
  assert.equal(resolveGuardIntervalMinutes(ctx.deps, {}), 1);
  ctx.fs.write(ctx.paths.guardInterval, "7\n");
  assert.equal(readPersistedGuardInterval(ctx.deps), 7);
  assert.equal(resolveGuardIntervalMinutes(ctx.deps, {}), 7);
  assert.equal(resolveGuardIntervalMinutes(ctx.deps, { OPENBOT_GUARD_INTERVAL: "3" }), 3);
  // Junk in either place falls back instead of throwing: an unreadable tuning
  // file must not keep the guard from starting.
  ctx.fs.write(ctx.paths.guardInterval, "later\n");
  assert.equal(readPersistedGuardInterval(ctx.deps), undefined);
  assert.equal(resolveGuardIntervalMinutes(ctx.deps, { OPENBOT_GUARD_INTERVAL: "" }), 1);
  assert.equal(resolveGuardIntervalMinutes(ctx.deps, { OPENBOT_GUARD_INTERVAL: "0" }), 1);
  assert.equal(resolveGuardIntervalMinutes(ctx.deps, { OPENBOT_GUARD_INTERVAL: "100" }), 60);
});

test("guard rejects a non-numeric interval", () => {
  assert.throws(() => parseInstallCommand({ argv: ["guard", "--daemon", "--interval", "soon"], env: {}, repoRoot: "/tmp/openbot" }), /--interval/);
  assert.throws(() => parseInstallCommand({ argv: ["guard", "--interval", ""], env: {}, repoRoot: "/tmp/openbot" }), /--interval/);
});

test("daemon ticks probe hop by default and record the patrol in the guard log", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = setup(true);
  const controller = new AbortController();
  const run = runGuardDaemon(ctx.deps, {
    intervalMinutes: DEFAULT_GUARD_INTERVAL_MINUTES,
    signal: controller.signal,
    runOnce: async () => HEALTHY,
  });
  await flush();
  controller.abort();
  await run;
  const rows = guardLogRows(ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.hopStatus, "healthy");
  assert.equal(rows[0]?.hopFailures, 0);
});

test("disabling the hop patrol keeps the tick hop-free", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = setup();
  const controller = new AbortController();
  const run = runGuardDaemon(ctx.deps, {
    intervalMinutes: DEFAULT_GUARD_INTERVAL_MINUTES,
    signal: controller.signal,
    runOnce: async () => HEALTHY,
    hopHealth: false,
  });
  await flush();
  controller.abort();
  await run;
  const rows = guardLogRows(ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.hopStatus, undefined);
  assert.equal(rows[0]?.hopFailures, undefined);
});

test("a dark unified port makes the guard tick restart the UI service, never hop-server", async () => {
  // Regression: the patrol once spawned payload/hop-server.cjs onto 9280,
  // which won the bind race and killed the UI with EADDRINUSE (/api/* 404).
  // Track spawns through the pidfiles the fake procs layer records.
  const ctx = setup(false);
  const stderr: string[] = [];
  const io = { runOnce: async () => HEALTHY, stderr: (line: string) => stderr.push(line) };
  await runGuardTickWithHopHealth(ctx.deps, { ...io, hopFailureThreshold: 1 });
  const rows = guardLogRows(ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.hopStatus, "restarted");
  assert.equal(ctx.fs.read(ctx.paths.uiPid), "1\n");
  assert.equal(ctx.fs.read(ctx.paths.hopPid), undefined);
  assert.match(stderr[0] ?? "", /hop was down.*restarted as pid 1/);
});

test("a dark unified port with a deaf-but-listed UI pid SIGTERMs it before the restart", async () => {
  const ctx = setup(false);
  ctx.fs.write(ctx.paths.uiPid, "4242\n");
  ctx.procs.live.add(4242);
  const stderr: string[] = [];
  const io = { runOnce: async () => HEALTHY, stderr: (line: string) => stderr.push(line) };
  await runGuardTickWithHopHealth(ctx.deps, { ...io, hopFailureThreshold: 1 });
  assert.deepEqual(ctx.procs.stopped, [4242]);
  assert.equal(ctx.fs.read(ctx.paths.uiPid), "1\n");
  assert.equal(ctx.fs.read(ctx.paths.hopPid), undefined);
});

// ---- Repair-bounce completion: the running host must actually load the
// repaired wrap. The fake procs report live host pids only when the test
// arms them, so a bounce shows up in procs.stopped.

function withHostPids(ctx: ReturnType<typeof setup>, pids: number[]): void {
  ctx.procs.hostPids = () => pids.map(parseOwnedPid);
  ctx.procs.live = new Set(pids);
}

/**
 * Arm a marker the way the box does: through the real writer, with a
 * fingerprint that matches what currentPayloadFingerprint computes over this
 * (empty) payload tree, then back-age it to the wanted age.
 */
function armPendingMarker(ctx: ReturnType<typeof setup>, ageMs: number): void {
  const fp = payloadFingerprint({
    payloadDir: joinAbs(ctx.paths.repoRoot, "payload"),
    read: () => undefined,
  });
  const marker = armDeferredHostBounce(ctx.deps, { source: "test:install" }, fp);
  ctx.fs.write(
    ctx.paths.pendingBounce,
    JSON.stringify(
      {
        ...marker,
        armedAtMs: marker.armedAtMs - ageMs,
        armedAt: new Date(marker.armedAtMs - ageMs).toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
}

test("a wrap repair with no pending marker completes immediately (bounce done)", async () => {
  const ctx = setup();
  withHostPids(ctx, [670974]);
  await runGuardTick(ctx.deps, { runOnce: async () => REPAIRED_WRAP, stderr: () => {} });
  // No marker was armed, so reconcile's own immediate bounce already ran
  // inside the repair: the daemon records the outcome and never double-kills.
  assert.deepEqual(ctx.procs.stopped, []);
  const rows = guardLogRows(ctx);
  assert.equal(rows[0]?.wrapBounce, "bounced");
});

test("a wrap repair whose stranded bounce is forced past the grace by the daemon", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = setup();
  withHostPids(ctx, [670974]);
  // A pending marker without a live finalizer: the exact stranded state. The
  // marker is old enough to pass its own grace window, and a fresh "stop"
  // lease keeps the quiet window open so only the forced apply may land.
  armPendingMarker(ctx, 150_000);
  const writeQuietLease = () => {
    const now = Date.now();
    ctx.fs.write(
      ctx.paths.turnLease,
      JSON.stringify({ active: 0, lastStartAt: now - 20_000, lastEndAt: now - 10_000, lastFinishReason: "stop", updatedAt: now - 10_000 }) + "\n",
    );
  };
  writeQuietLease();
  const stderr: string[] = [];
  const controller = new AbortController();
  const run = runGuardDaemon(ctx.deps, {
    intervalMinutes: DEFAULT_GUARD_INTERVAL_MINUTES,
    signal: controller.signal,
    runOnce: async () => REPAIRED_WRAP,
    stderr: (line) => stderr.push(line),
    hopHealth: false,
  });
  await flush();
  // First repair tick: the finalizer still gets its grace, and the quiet
  // window keeps the normal fallback from applying.
  assert.deepEqual(ctx.procs.stopped, []);
  assert.equal(ctx.fs.read(ctx.paths.pendingBounce) !== undefined, true);
  assert.equal(guardLogRows(ctx)[0]?.wrapBounce, "deferred");
  // Second repair tick: the daemon forces the stranded deferred bounce
  // through the audited applier instead of leaving the host on the old wrap.
  t.mock.timers.tick(5 * 60_000);
  writeQuietLease();
  await flush();
  assert.deepEqual(ctx.procs.stopped, [670974]);
  const rows = guardLogRows(ctx);
  assert.equal(rows[1]?.wrapBounce, "bounced");
  controller.abort();
  await run;
  // The forced completion is auditable like every reconcile write.
  const actions = auditRows(ctx).map((row) => [row.action, row.from, row.to]);
  assert.deepEqual(actions, [
    ["guard", "wrap-drift", "custom"],
    ["guard", "wrap-drift", "custom"],
    ["wrap", "bounce:deferred+max-wait", "bounce:done"],
  ]);
  assert.equal(ctx.fs.read(ctx.paths.pendingBounce), undefined);
  assert.match(stderr.join("\n"), /forced the stranded wrap-repair bounce \(pid 670974\)/);
  assert.equal(GUARD_BOUNCE_GRACE_TICKS, 2);
});

test("a young stranded bounce is never forced through the grace window", async () => {
  const ctx = setup();
  withHostPids(ctx, [670974]);
  // Freshly armed (inside its own grace window): even with the repair
  // stranded, the daemon must wait the grace out — the install that armed it
  // may still be writing its result.
  armPendingMarker(ctx, 0);
  let n = 0;
  while (n < GUARD_BOUNCE_GRACE_TICKS) {
    await runGuardTick(ctx.deps, { runOnce: async () => REPAIRED_WRAP, stderr: () => {} });
    n += 1;
  }
  assert.deepEqual(ctx.procs.stopped, []);
  assert.deepEqual(
    guardLogRows(ctx).map((row) => row.wrapBounce),
    ["deferred", "deferred"],
  );
  assert.equal(ctx.fs.read(ctx.paths.pendingBounce) !== undefined, true);
});

test("a wrap repair without a pending marker resets the grace counter", async () => {
  const ctx = setup();
  withHostPids(ctx, [670974]);
  // Repair tick 1 defers (a marker is armed); the finalizer then applies it,
  // and the next repair with no marker completes immediately instead of
  // counting as a second deferral.
  armPendingMarker(ctx, 150_000);
  await runGuardTick(ctx.deps, { runOnce: async () => REPAIRED_WRAP, stderr: () => {} });
  assert.equal(guardLogRows(ctx)[0]?.wrapBounce, "deferred");
  ctx.fs.remove(ctx.paths.pendingBounce);
  await runGuardTick(ctx.deps, { runOnce: async () => REPAIRED_WRAP, stderr: () => {} });
  assert.deepEqual(ctx.procs.stopped, []);
  assert.equal(guardLogRows(ctx)[1]?.wrapBounce, "bounced");
});

const STOCK = `function createProtoSessionProvider(client) {
  return { getSession: function () { return 1; } };
}
`;

const ORIGIN = parseUpstreamOrigin("https://open.bigmodel.cn/api/paas/v4");

/** The daemon's own pidfile content, written by runGuardDaemon itself. */
function ownPidfile(ctx: ReturnType<typeof setup>): void {
  ctx.fs.write(ctx.paths.guardPid, `${String(process.pid)}\n`);
}

/**
 * A custom box whose host file is stock-unmarked, so the next tick repairs the
 * wrap. The UI service is already ours (live pidfile plus open port) so the
 * repair adopts it instead of restarting it: this is about the guard.
 */
function driftingCustomBox(ctx: ReturnType<typeof setup>): void {
  ctx.fs.write(ctx.paths.hostMain, STOCK);
  ctx.fs.write(ctx.paths.mode, "custom\n");
  ctx.fs.write(
    ctx.paths.plan,
    planToJson(
      compileCustomPlan(
        customBoxFromProvider({ paths: ctx.paths, origin: ORIGIN, name: "Zhipu", modelSlug: "glm-5.3-flash" }),
      ),
    ),
  );
  ctx.fs.write(ctx.paths.uiPid, "43\n");
  ctx.procs.live.add(43);
}

test("a wrap repair tick leaves the daemon that ran it alive", async () => {
  // The production failure, end to end: the pidfile names this process (as it
  // does for the real daemon), the box is custom, and the host is stock, so
  // this tick repairs the wrap. The repair changes the wrap bytes, which used
  // to SIGTERM that very pid -- the daemon died inside its own successful
  // repair and the log went silent for hours.
  const ctx = setup(true);
  driftingCustomBox(ctx);
  ownPidfile(ctx);
  const stderr: string[] = [];
  await runGuardTickWithHopHealth(ctx.deps, {
    runOnce: (d) => guardCustom(d, { source: GUARD_DAEMON_SOURCE }),
    stderr: (line) => stderr.push(line),
    hopHealth: false,
  });
  assert.equal(ctx.procs.stopped.includes(process.pid), false);
  assert.equal(ctx.fs.read(ctx.paths.guardPid), `${String(process.pid)}\n`);
  assert.equal(ctx.fs.read(ctx.paths.hostMain)?.includes(OPENBOT_MARKER), true);
  const rows = guardLogRows(ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.detail, "repaired");
  assert.equal(rows[0]?.wrapRepaired, true);
  assert.deepEqual(stderr, []);
});

