import { guardCustom, type GuardResult } from "./guard.ts";
import { type SupervisorDeps } from "./observe.ts";
import { parseOwnedPid } from "./procs.ts";
import { appendGuardAudit, applyDeferredHostBounce, finalizeHostRunning, pendingHostBounce } from "./reconcile.ts";
import { DEFAULT_HOP_FAILURE_THRESHOLD, runHopHealthCheck } from "./hop-health.ts";

/**
 * The scheduled custom-state guard. It reuses guardCustom for every check and
 * repair, so it inherits the hard constraint: it never writes the official
 * mode token, never reconciles an official desired state, and never removes
 * the wrap. The official channel has zero quota, so drift always heals back
 * to custom or is refused — never fallen back to official.
 */

export const GUARD_DAEMON_SOURCE = "guard-daemon";
export const DEFAULT_GUARD_INTERVAL_MINUTES = 5;

/** The guard log stays small: past this size the next tick truncates it. */
export const GUARD_LOG_MAX_BYTES = 1024 * 1024;

export type GuardLogRow = {
  readonly ts: string;
  readonly detail: string;
  readonly ok: boolean;
  readonly modeRepaired: boolean;
  readonly wrapRepaired: boolean;
  readonly hopStatus?: string | undefined;
  readonly hopFailures?: number | undefined;
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
};

export type GuardTickIo = {
  readonly runOnce: (deps: SupervisorDeps) => Promise<GuardResult>;
  readonly stderr: (line: string) => void;
};

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

export function appendGuardLogLine(
  deps: SupervisorDeps,
  row: { detail: string; ok: boolean; modeRepaired: boolean; wrapRepaired: boolean; hopStatus?: string | undefined; hopFailures?: number | undefined },
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

/** One loop pass: check, repair through guardCustom, record, keep going.
 * Kept for the CLI one-shot path: no hop patrol, log rows unchanged. */
export async function runGuardTick(deps: SupervisorDeps, io: GuardTickIo): Promise<void> {
  await runGuardTickWithHopHealth(deps, { ...io, hopHealth: false });
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
  if (result.detail === "repaired") {
    const drifted = [result.modeRepaired ? "mode-drift" : undefined, result.wrapRepaired ? "wrap-drift" : undefined]
      .filter((part): part is string => part !== undefined)
      .join("+");
    appendGuardAudit(deps, { source: GUARD_DAEMON_SOURCE }, drifted || "drift", "custom");
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
  appendGuardLogLine(deps, { ...result, hopStatus, hopFailures });
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

/**
 * Run the guard loop until the abort signal fires. One tick runs immediately,
 * the next is scheduled only after the previous one settles, so slow repairs
 * never overlap. Refused and no-custom-state ticks log to stderr and keep the
 * loop alive; the loop never reconciles an official desired state.
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
  try {
    while (signal?.aborted !== true) {
      await runGuardTickWithHopHealth(deps, {
        runOnce,
        stderr,
        hopHealth: opts.hopHealth,
        hopFailureThreshold: opts.hopFailureThreshold,
      });
      // If the signal fired during the tick, sleep resolves immediately and
      // the while condition ends the loop without scheduling real work.
      await sleep(intervalMs, signal);
    }
  } finally {
    releaseOwnPidfile(deps);
  }
  return { kind: "stopped" };
}
