import { guardCustom, type GuardResult } from "./guard.ts";
import { type SupervisorDeps } from "./observe.ts";
import { joinAbs } from "./paths.ts";
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
/**
 * Minutes between guard patrols. One minute, not five: a patrol reads two
 * files and compares bytes, so the cost is irrelevant next to the drift window
 * it closes -- five minutes of a host sitting on stock Grok is exactly the
 * "it switched itself back to official" the user reports.
 */
export const DEFAULT_GUARD_INTERVAL_MINUTES = 1;
/** `OPENBOT_GUARD_INTERVAL` (minutes) overrides the interval for one start. */
export const GUARD_INTERVAL_ENV = "OPENBOT_GUARD_INTERVAL";

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

/**
 * The minutes recorded for this box in `$DATA/openbot-guard-interval`, when
 * the file holds a usable number. This is the persistence half of the
 * interval: install.sh reads the same file, so a value a human chose survives
 * every later install instead of being reset to the default.
 */
export function readPersistedGuardInterval(deps: SupervisorDeps): number | undefined {
  const raw = deps.fs.read(deps.paths.guardInterval)?.trim();
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return clampIntervalMinutes(value);
}

/**
 * The interval a fresh daemon should run at, by the same precedence install.sh
 * uses: `OPENBOT_GUARD_INTERVAL` (minutes) > the persisted file > the default.
 * Both start paths (install.sh and guard-watch.ts) resolve it this way, so a
 * restarted daemon patrols at the box's chosen rate, not at the default.
 */
export function resolveGuardIntervalMinutes(
  deps: SupervisorDeps,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const flagged = env[GUARD_INTERVAL_ENV];
  if (flagged !== undefined && flagged.trim() !== "" && Number.isFinite(Number(flagged))) {
    return clampIntervalMinutes(Number(flagged));
  }
  return readPersistedGuardInterval(deps) ?? DEFAULT_GUARD_INTERVAL_MINUTES;
}

/**
 * Start the detached guard daemon the way install.sh starts it:
 * `node --experimental-strip-types src/cli.ts guard --daemon` with this box's
 * own --host-main/--sand-data, detached, at the box's resolved interval.
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
      // Always explicit: without it the child would fall back to the CLI
      // default, which is not what a box with a persisted interval asked for.
      "--interval",
      String(resolveGuardIntervalMinutes(deps)),
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
  let wrapBounce: "bounced" | "deferred" | undefined;
  if (result.detail === "repaired") {
    const drifted = [result.modeRepaired ? "mode-drift" : undefined, result.wrapRepaired ? "wrap-drift" : undefined]
      .filter((part): part is string => part !== undefined)
      .join("+");
    appendGuardAudit(deps, { source: GUARD_DAEMON_SOURCE }, drifted || "drift", "custom");
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
