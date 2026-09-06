import { guardCustom, type GuardResult } from "./guard.ts";
import { type SupervisorDeps } from "./observe.ts";
import { parseOwnedPid } from "./procs.ts";
import { appendGuardAudit } from "./reconcile.ts";

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
  row: { detail: string; ok: boolean; modeRepaired: boolean; wrapRepaired: boolean },
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

/** One loop pass: check, repair through guardCustom, record, keep going. */
export async function runGuardTick(deps: SupervisorDeps, io: GuardTickIo): Promise<void> {
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
  appendGuardLogLine(deps, result);
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
      await runGuardTick(deps, { runOnce, stderr });
      // If the signal fired during the tick, sleep resolves immediately and
      // the while condition ends the loop without scheduling real work.
      await sleep(intervalMs, signal);
    }
  } finally {
    releaseOwnPidfile(deps);
  }
  return { kind: "stopped" };
}
