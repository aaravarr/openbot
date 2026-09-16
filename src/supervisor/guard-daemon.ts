import { guardCustom, type GuardResult } from "./guard.ts";
import { appendWrapDriftEvent, nodeGuardEventSink, type GuardEventSink, type GuardTickTrigger } from "./guard-events.ts";
import { type SupervisorDeps } from "./observe.ts";
import { joinAbs } from "./paths.ts";
import { parseOwnedPid } from "./procs.ts";
import { appendGuardAudit, applyDeferredHostBounce, finalizeHostRunning, pendingHostBounce } from "./reconcile.ts";
import { DEFAULT_HOP_FAILURE_THRESHOLD, runHopHealthCheck } from "./hop-health.ts";
import {
  clampDriftPollMs,
  createWrapDriftDetector,
  driftPollMsFromEnv,
  type WrapDriftDetector,
  type WrapDriftFinding,
  type WrapDriftProbe,
  type WrapDriftVerdict,
} from "./wrap-drift.ts";

/**
 * The scheduled custom-state guard. It reuses guardCustom for every check and
 * repair, so it inherits the hard constraint: it never writes the official
 * mode token, never reconciles an official desired state, and never removes
 * the wrap. The official channel has zero quota, so drift always heals back
 * to custom or is refused — never fallen back to official.
 *
 * Between two scheduled ticks the loop also watches the host file with a cheap
 * stat poll (wrap-drift.ts). A drift finding repairs nothing by itself: it
 * wakes the loop early and runs the identical tick, so every rail above applies
 * unchanged. Only the recorded trigger differs (schedule vs drift-poll).
 */

export const GUARD_DAEMON_SOURCE = "guard-daemon";
export const DEFAULT_GUARD_INTERVAL_MINUTES = 5;

/** The guard log stays small: past this size the next tick truncates it. */
export const GUARD_LOG_MAX_BYTES = 1024 * 1024;

/**
 * The wrap repair is not complete until the host process has restarted on the
 * repaired bytes: the running host keeps its own module cache, so chat only
 * truly leaves stock when a new host starts. When the repair reconcile
 * deferred the bounce (an armed pending marker, applied by a finalizer or a
 * later tick), one repair cycle is granted to land it before this daemon
 * bounces the host itself. Anything longer is the observed complaint: the
 * files heal, the process stays stock, and the log says healthy.
 */
export const GUARD_BOUNCE_GRACE_TICKS = 2;

export type GuardLogRow = {
  readonly ts: string;
  readonly detail: string;
  readonly ok: boolean;
  readonly modeRepaired: boolean;
  readonly wrapRepaired: boolean;
  readonly hopStatus?: string | undefined;
  readonly hopFailures?: number | undefined;
  /** Set when the tick completed or deferred the post-repair host bounce. */
  readonly wrapBounce?: "bounced" | "deferred" | undefined;
  /** Which path ran the tick: the schedule, the fast poll, or a one-shot. */
  readonly trigger?: GuardTickTrigger | undefined;
};

export type GuardDaemonOutcome =
  | { readonly kind: "stopped" }
  | { readonly kind: "already-running"; readonly pid: number };

export type GuardDaemonOpts = {
  readonly intervalMinutes: number;
  /** The CLI aborts this on SIGTERM/SIGINT; tests abort it manually. */
  readonly signal?: AbortSignal;
  /** Overridable for tests. Defaults to guardCustom with the daemon source. */
  readonly runOnce?: (deps: SupervisorDeps) => Promise<GuardResult>;
  readonly stderr?: (line: string) => void;
  /** Probe-and-restart patrol for the runtime's hop address. Default on. */
  readonly hopHealth?: boolean;
  readonly hopFailureThreshold?: number;
  /**
   * Fast wrap-drift poll cadence in ms. `0` disables it. Defaults to
   * OPENBOT_GUARD_DRIFT_POLL_MS, then DEFAULT_DRIFT_POLL_MS. See wrap-drift.ts.
   */
  readonly driftPollMs?: number;
  /** Overridable stat/head probe. Defaults to node:fs (wrap-drift.ts). */
  readonly driftProbe?: WrapDriftProbe;
  /** Overridable wrap-drift event sink. Defaults to the shared events JSONL. */
  readonly driftEvents?: GuardEventSink;
};

export type GuardTickIo = {
  readonly runOnce: (deps: SupervisorDeps) => Promise<GuardResult>;
  readonly stderr: (line: string) => void;
  readonly trigger?: GuardTickTrigger | undefined;
  /** The fast-poll verdict, recorded on the drift event. */
  readonly driftReason?: string | undefined;
  readonly events?: GuardEventSink | undefined;
};

/** Production event sink: append to the events JSONL the control page reads. */
const defaultEvents: GuardEventSink = nodeGuardEventSink();

export function clampIntervalMinutes(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_GUARD_INTERVAL_MINUTES;
  }
  return Math.min(60, Math.max(1, Math.round(raw)));
}

/** The pid in the guard pidfile, but only when that process is still alive. */
export function guardDaemonPid(deps: SupervisorDeps): number | undefined {
  const pid = deps.procs.readPidFile(deps.paths.guardPid);
  if (pid === undefined) {
    return undefined;
  }
  return deps.procs.pidAlive(pid) ? pid : undefined;
}

/**
 * SIGTERM the daemon named by the pidfile (same lifecycle as the owned
 * tunnel). Clearing the pidfile here and in the daemon's own cleanup is
 * safe: both remove only a pidfile that still names the same process.
 */
export function stopGuardDaemon(deps: SupervisorDeps): boolean {
  const pid = guardDaemonPid(deps);
  if (pid === undefined) {
    deps.fs.remove(deps.paths.guardPid);
    return false;
  }
  deps.procs.stop(parseOwnedPid(pid));
  releaseGuardPidfileFor(deps, pid);
  return true;
}

function releaseGuardPidfileFor(deps: SupervisorDeps, pid: number): void {
  try {
    const current = deps.procs.readPidFile(deps.paths.guardPid);
    if (current === pid) {
      deps.fs.remove(deps.paths.guardPid);
    }
  } catch {
    /* pidfile cleanup is best-effort */
  }
}

function releaseOwnPidfile(deps: SupervisorDeps): void {
  releaseGuardPidfileFor(deps, process.pid);
}

/**
 * Start the detached guard daemon the way install.sh starts it:
 * `node --experimental-strip-types src/cli.ts guard --daemon` with this box's
 * own --host-main/--sand-data, detached, default interval (5 minutes).
 *
 * The pidfile is deliberately NOT pre-written for the child. The daemon
 * publishes its own pid and refuses to start while that pidfile names a live
 * process, so a pid written by the parent would be read straight back as an
 * existing daemon (itself) and the spawn would exit without patrolling; it
 * would also overwrite the lock a concurrently starting daemon already holds.
 * Leaving the file alone keeps that lock as the single authority, exactly as
 * install.sh does it.
 *
 * Whether to start at all is the caller's decision (see guard-watch.ts); this
 * only spawns. The child's stderr shares the service log: its structured rows
 * go to openbot-guard.log, and keeping plain text out of that JSONL file is
 * what lets every line of it stay parseable.
 */
export function startGuardDaemon(deps: SupervisorDeps): number {
  deps.fs.mkdirp(deps.paths.sandData);
  return deps.procs.start({
    argv: [
      "--experimental-strip-types",
      joinAbs(deps.paths.repoRoot, "src/cli.ts"),
      "guard",
      "--daemon",
      "--host-main",
      deps.paths.hostMain,
      "--sand-data",
      deps.paths.sandData,
    ],
    env: { ...process.env },
    log: deps.paths.uiLog,
    pidFile: deps.paths.guardPid,
    writePidFile: false,
  });
}

export function appendGuardLogLine(
  deps: SupervisorDeps,
  row: {
    detail: string;
    ok: boolean;
    modeRepaired: boolean;
    wrapRepaired: boolean;
    hopStatus?: string | undefined;
    hopFailures?: number | undefined;
    wrapBounce?: "bounced" | "deferred" | undefined;
    trigger?: GuardTickTrigger | undefined;
  },
): void {
  try {
    const entry: GuardLogRow = { ts: new Date().toISOString(), ...row };
    const existing = deps.fs.read(deps.paths.guardLog);
    const keep = existing !== undefined && existing.length <= GUARD_LOG_MAX_BYTES ? existing : "";
    deps.fs.write(deps.paths.guardLog, `${keep}${JSON.stringify(entry)}\n`, 0o644);
  } catch {
    /* the guard log is best-effort */
  }
}

/**
 * Tick-scoped memory for the repair-bounce grace counter. A daemon is a
 * single loop, so one module-level slot per process is enough; the one-shot
 * CLI tick never defers past it (grace only spans ticks of the same loop).
 */
const repairState: { bounceDeferrals: number } = { bounceDeferrals: 0 };

/**
 * True while the repair's deferred host bounce is stranded: a marker is
 * armed but no live finalizer owns it. The tick's normal fallback lets the
 * finalizer win the race; only the grace counter below overrides it.
 */
function repairBounceStranded(deps: SupervisorDeps): boolean {
  return pendingHostBounce(deps) && !finalizeHostRunning(deps);
}

/** One loop pass: check, repair through guardCustom, record, keep going.
 * Kept for the CLI one-shot path: no hop patrol, log rows unchanged. */
export async function runGuardTick(deps: SupervisorDeps, io: GuardTickIo): Promise<void> {
  await runGuardTickWithHopHealth(deps, { ...io, trigger: "manual", hopHealth: false });
}

/** All tick work: custom-state repair plus the hop patrol, kept independent
 * so one failing half cannot swallow the other. */
export async function runGuardTickWithHopHealth(
  deps: SupervisorDeps,
  io: GuardTickIo & { hopHealth?: boolean | undefined; hopFailureThreshold?: number | undefined },
): Promise<void> {
  let result: GuardResult;
  try {
    result = await io.runOnce(deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`openbot-guard: tick failed: ${message}`);
    appendGuardLogLine(deps, { detail: "error", ok: false, modeRepaired: false, wrapRepaired: false });
    return;
  }
  let wrapBounce: "bounced" | "deferred" | undefined;
  if (result.detail === "repaired") {
    const drifted = [result.modeRepaired ? "mode-drift" : undefined, result.wrapRepaired ? "wrap-drift" : undefined]
      .filter((part): part is string => part !== undefined)
      .join("+");
    appendGuardAudit(deps, { source: GUARD_DAEMON_SOURCE }, drifted || "drift", "custom");
    if (result.wrapRepaired) {
      // Visible in the control page's event list, whichever path found the
      // drift. Best-effort: the audit line and the guard log row above already
      // carry the repair (see guard-events.ts).
      appendWrapDriftEvent(
        deps,
        {
          hostMain: deps.paths.hostMain,
          trigger: io.trigger ?? "schedule",
          modeRepaired: result.modeRepaired,
          ...(io.driftReason !== undefined ? { reason: io.driftReason } : {}),
        },
        io.events ?? defaultEvents,
      );
    }
    if (result.wrapRepaired && repairBounceStranded(deps)) {
      // The repair deferred the host bounce to a finalizer that never came.
      // Grant GUARD_BOUNCE_GRACE_TICKS repair ticks, then force the deferred
      // bounce through the audited applier: force expires only the quiet
      // window and the no-lease fallback, never the marker grace window and
      // never a request that is still in flight.
      repairState.bounceDeferrals += 1;
      if (repairState.bounceDeferrals >= GUARD_BOUNCE_GRACE_TICKS) {
        const applied = applyDeferredHostBounce(deps, { source: GUARD_DAEMON_SOURCE }, { force: true });
        wrapBounce = applied.kind === "applied" ? "bounced" : "deferred";
        repairState.bounceDeferrals = 0;
        if (applied.kind === "applied") {
          io.stderr(`openbot-guard: forced the stranded wrap-repair bounce (pid ${applied.pids.join(", ")})`);
        }
      } else {
        wrapBounce = "deferred";
      }
    } else if (result.wrapRepaired && !pendingHostBounce(deps)) {
      // The repair bounced the host itself (immediate path) or the normal
      // fallback applied the marker earlier in this tick.
      repairState.bounceDeferrals = 0;
      wrapBounce = "bounced";
    }
  } else {
    // Keep counting only while a bounce is actually stranded; a tick with
    // no marker, or with a live finalizer, resets the grace window.
    if (repairBounceStranded(deps)) {
      repairState.bounceDeferrals += 1;
    } else {
      repairState.bounceDeferrals = 0;
    }
  }
  if (result.detail === "refused" || result.detail === "no-custom-state") {
    io.stderr(`openbot-guard: ${result.detail}; retrying on the next tick`);
  }
  let hopStatus: string | undefined;
  let hopFailures: number | undefined;
  if (io.hopHealth !== false) {
    try {
      const hop = await runHopHealthCheck(deps, {
        failureThreshold: io.hopFailureThreshold ?? DEFAULT_HOP_FAILURE_THRESHOLD,
        source: GUARD_DAEMON_SOURCE,
      });
      hopStatus = hop.status;
      hopFailures = hop.failures;
      if (hop.status === "restarted") {
        io.stderr(`openbot-guard: hop was down (${hop.target.host}:${hop.target.port}); restarted as pid ${hop.pid}`);
      } else if (hop.status === "degraded") {
        io.stderr(`openbot-guard: hop probe failed ${hop.failures}x (${hop.target.host}:${hop.target.port})`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      io.stderr(`openbot-guard: hop health failed: ${message}`);
      hopStatus = "error";
    }
  }
  // Fallback for an armed deferred host bounce. The detached finalizer is the
  // normal applier; it can be missing when the box rebooted, the worker was
  // killed, or the spawn failed. One attempt per tick is enough: the applier is
  // idempotent and only fires once the host is idle.
  if (pendingHostBounce(deps) && !finalizeHostRunning(deps)) {
    try {
      const applied = applyDeferredHostBounce(deps, { source: GUARD_DAEMON_SOURCE });
      if (applied.kind === "applied") {
        io.stderr(`openbot-guard: applied a deferred host bounce (pid ${applied.pids.join(", ")})`);
      } else if (applied.kind === "skipped" && applied.reason !== "no-marker") {
        io.stderr(`openbot-guard: dropped a deferred host bounce (${applied.reason})`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      io.stderr(`openbot-guard: deferred host bounce failed: ${message}`);
    }
  }
  appendGuardLogLine(deps, {
    ...result,
    hopStatus,
    hopFailures,
    ...(wrapBounce !== undefined ? { wrapBounce } : {}),
    ...(io.trigger !== undefined ? { trigger: io.trigger } : {}),
  });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export type GuardWakeOutcome =
  | { readonly kind: "interval" }
  | { readonly kind: "aborted" }
  | { readonly kind: "drift"; readonly drift: WrapDriftFinding };

/**
 * Wait out the rest of the interval, but wake early the moment the fast poll
 * reports drift. Two timers, one clock: the interval timer is armed once, and a
 * poll timer re-arms itself until one of them fires.
 *
 * The poll runs synchronously inside its timer callback (stat plus, only when
 * the fingerprint moved, one short read), so a poll costs no promises and the
 * whole wait stays at one microtask per wake -- the scheduled tick's cadence is
 * unchanged, and so is every test that drives it with mock timers.
 */
export function waitForGuardWake(input: {
  readonly intervalMs: number;
  readonly pollMs: number;
  readonly detector: WrapDriftDetector;
  readonly signal?: AbortSignal | undefined;
}): Promise<GuardWakeOutcome> {
  return new Promise((resolve) => {
    if (input.signal?.aborted === true) {
      resolve({ kind: "aborted" });
      return;
    }
    let settled = false;
    let intervalTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (outcome: GuardWakeOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (intervalTimer !== undefined) {
        clearTimeout(intervalTimer);
      }
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer);
      }
      input.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    function onAbort(): void {
      done({ kind: "aborted" });
    }
    const schedulePoll = (): void => {
      pollTimer = setTimeout(() => {
        let verdict: WrapDriftVerdict;
        try {
          verdict = input.detector.poll();
        } catch {
          // A probe failure is not drift: the scheduled tick still runs.
          verdict = { kind: "none" };
        }
        if (verdict.kind === "drift") {
          done({ kind: "drift", drift: verdict });
          return;
        }
        schedulePoll();
      }, input.pollMs);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    intervalTimer = setTimeout(() => {
      done({ kind: "interval" });
    }, input.intervalMs);
    schedulePoll();
  });
}

/**
 * Run the guard loop until the abort signal fires. One tick runs immediately,
 * the next is scheduled only after the previous one settles, so slow repairs
 * never overlap. Refused and no-custom-state ticks log to stderr and keep the
 * loop alive; the loop never reconciles an official desired state.
 *
 * Between two scheduled ticks a stat poll watches the host file (wrap-drift.ts).
 * Grok Bot's idle auto-update rewrites it every few hours and the scheduled
 * interval is minutes, so the poll is what turns a multi-minute stock fallback
 * into a few seconds. A poll verdict does not repair anything by itself: it runs
 * the very same tick, through the same guardCustom, with every rail intact.
 */
export async function runGuardDaemon(deps: SupervisorDeps, opts: GuardDaemonOpts): Promise<GuardDaemonOutcome> {
  const owner = guardDaemonPid(deps);
  if (owner !== undefined) {
    return { kind: "already-running", pid: owner };
  }
  deps.fs.write(deps.paths.guardPid, `${process.pid}\n`, 0o644);
  const runOnce = opts.runOnce ?? ((d: SupervisorDeps) => guardCustom(d, { source: GUARD_DAEMON_SOURCE }));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));
  const intervalMs = clampIntervalMinutes(opts.intervalMinutes) * 60_000;
  const signal = opts.signal;
  const driftPollMs = clampDriftPollMs(opts.driftPollMs ?? driftPollMsFromEnv(process.env));
  // A poll that cannot fire between two scheduled ticks buys nothing.
  const pollMs = driftPollMs > 0 && driftPollMs < intervalMs ? driftPollMs : 0;
  const detector =
    pollMs > 0
      ? createWrapDriftDetector({
          hostMain: deps.paths.hostMain,
          mode: () => deps.fs.read(deps.paths.mode),
          ...(opts.driftProbe !== undefined ? { probe: opts.driftProbe } : {}),
        })
      : undefined;
  const tickIo: GuardTickIo & {
    hopHealth?: boolean | undefined;
    hopFailureThreshold?: number | undefined;
  } = {
    runOnce,
    stderr,
    hopHealth: opts.hopHealth,
    hopFailureThreshold: opts.hopFailureThreshold,
    ...(opts.driftEvents !== undefined ? { events: opts.driftEvents } : {}),
  };
  try {
    // The wait comes after every tick, whichever tick it was: a drift repair is
    // not followed by the scheduled tick it would have replaced, and a slow
    // repair never overlaps the next one. `next` is therefore exactly the tick
    // that is due, and undefined only when the abort ended the wait.
    let next: { readonly trigger: GuardTickTrigger; readonly reason?: string } | undefined = { trigger: "schedule" };
    while (next !== undefined && signal?.aborted !== true) {
      const due = next;
      await runGuardTickWithHopHealth(deps, {
        ...tickIo,
        trigger: due.trigger,
        ...(due.reason !== undefined ? { driftReason: due.reason } : {}),
      });
      // Adopt whatever the tick left on disk. Without this the repair's own
      // write would read back as a new drift, and every repair would re-arm
      // itself in a loop.
      detector?.rebaseline();
      if (detector === undefined) {
        // If the signal fired during the tick, sleep resolves immediately and
        // the while condition ends the loop without scheduling real work.
        await sleep(intervalMs, signal);
        next = { trigger: "schedule" };
        continue;
      }
      const wake = await waitForGuardWake({ intervalMs, pollMs, detector, signal });
      if (wake.kind === "interval") {
        next = { trigger: "schedule" };
      } else if (wake.kind === "drift") {
        stderr(
          `openbot-guard: host wrap drift detected by the ${String(Math.round(pollMs / 1000))}s poll (${wake.drift.reason}); repairing now`,
        );
        next = { trigger: "drift-poll", reason: wake.drift.reason };
      } else {
        next = undefined;
      }
    }
  } finally {
    releaseOwnPidfile(deps);
  }
  return { kind: "stopped" };
}
