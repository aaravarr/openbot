import assert from "node:assert/strict";
import test from "node:test";
import { parseInstallCommand } from "../parse/argv.ts";
import { type FsDeps, type ProcDeps, parseOwnedPid } from "./procs.ts";
import { boxPathsFrom, joinAbs, type BoxPaths } from "./paths.ts";
import {
  DEFAULT_GUARD_INTERVAL_MINUTES,
  GUARD_LOG_MAX_BYTES,
  type GuardDaemonOutcome,
  type GuardLogRow,
  appendGuardLogLine,
  guardDaemonPid,
  runGuardDaemon,
  runGuardTick,
  stopGuardDaemon,
} from "./guard-daemon.ts";
import type { GuardResult } from "./guard.ts";

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
const REFUSED = guardResult({ detail: "refused", ok: false, reconcile: { kind: "refused", error: { kind: "foreign-hop" } } });
const NO_CUSTOM = guardResult({ detail: "no-custom-state", ok: false });

type FakeProcs = ProcDeps & { stopped: number[]; live: Set<number> };

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

function fakeProcs(fs: ReturnType<typeof memoryFs>): FakeProcs {
  const live = new Set<number>();
  const stopped: number[] = [];
  return {
    live,
    stopped,
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

function setup() {
  const paths: BoxPaths = boxPathsFrom({
    repoRoot: "/tmp/openbot-guard-repo",
    sandData: "/tmp/openbot-guard-data",
    hostMain: "/tmp/openbot-guard-host/host-main.cjs",
  });
  const fs = memoryFs();
  const procs = fakeProcs(fs);
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
  assert.deepEqual(parse(["guard"]), { kind: "guard", action: "once", intervalMinutes: 5 });
  assert.deepEqual(parse(["guard", "--daemon"]), { kind: "guard", action: "daemon", intervalMinutes: 5 });
  assert.deepEqual(parse(["guard", "--stop"]), { kind: "guard", action: "stop", intervalMinutes: 5 });
  assert.equal(parse(["guard", "--daemon", "--interval", "1"]).intervalMinutes, 1);
  assert.equal(parse(["guard", "--daemon", "--interval", "0"]).intervalMinutes, 1);
  assert.equal(parse(["guard", "--daemon", "--interval", "100"]).intervalMinutes, 60);
  assert.equal(parse(["guard", "--daemon", "--interval", "7"]).intervalMinutes, 7);
  assert.equal(parse(["guard", "--daemon", "--json"]).intervalMinutes, 5);
});

test("guard rejects a non-numeric interval", () => {
  assert.throws(() => parseInstallCommand({ argv: ["guard", "--daemon", "--interval", "soon"], env: {}, repoRoot: "/tmp/openbot" }), /--interval/);
  assert.throws(() => parseInstallCommand({ argv: ["guard", "--interval", ""], env: {}, repoRoot: "/tmp/openbot" }), /--interval/);
});
