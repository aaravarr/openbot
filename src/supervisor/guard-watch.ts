import { guardDaemonPid, startGuardDaemon } from "./guard-daemon.ts";
import { type SupervisorDeps } from "./observe.ts";

/**
 * Watch the watcher.
 *
 * The custom-state guard daemon is the only thing that heals host-file wrap
 * drift, and nothing brings it back when it dies: install.sh starts it once at
 * install time and reconcile only ever stops it. A crash, an OOM kill, or a
 * stop on any other path therefore ends drift recovery silently -- the host
 * stays on stock Grok until a human notices.
 *
 * The long-running loopback service (src/ui/server.ts) owns this bounded
 * babysitter: on a custom box it checks that the daemon named by
 * openbot-guard.pid is alive and starts one exactly the way install.sh does.
 * Rail by rail, in the order they can fire:
 *
 * - Never on official. An official box must not run a custom patrol: with a
 *   non-empty catalog the guard treats official mode as drift and flips it
 *   back to custom on its next tick.
 * - Never two at once. One start stays unconfirmed until the following check
 *   either finds the daemon or books the attempt as failed, and the daemon's
 *   own pidfile lock (runGuardDaemon) makes a duplicate exit by itself.
 * - Bounded retries. Consecutive failures double the wait up to
 *   GUARD_WATCH_BACKOFF_MAX_MS, so a start that can never work cannot become a
 *   spawn loop.
 * - Observable. Every start, recovery, and failure appends a guard.watch
 *   request-log event (and one line to the service's stderr). Events are
 *   written whether or not request recording is on.
 *
 * The mode is an input, not read here: src/ui/server.ts already owns the
 * strict rule (wrapMode: only the literal token "official" means official) and
 * a second copy of it would be a second thing to keep in step.
 */

/** How often the service checks that the guard daemon is alive. */
export const GUARD_WATCH_INTERVAL_MS = 60_000;
/**
 * The first check waits this long. install.sh starts its own daemon right
 * after the install reconcile -- the same reconcile that restarts this service
 * -- and that start must win, or every normal install would be reported as a
 * recovery.
 */
export const GUARD_WATCH_STARTUP_DELAY_MS = 60_000;
/** Wait after a failed start; doubles per consecutive failure. */
export const GUARD_WATCH_BACKOFF_BASE_MS = 60_000;
/** Ceiling for that backoff: at most one attempt per 15 minutes. */
export const GUARD_WATCH_BACKOFF_MAX_MS = 15 * 60_000;
/** `OPENBOT_GUARD_WATCH=0` turns the babysitter off. install.sh still starts one. */
export const GUARD_WATCH_DISABLE_ENV = "OPENBOT_GUARD_WATCH";

export type GuardWatchMode = "official" | "custom";

/** Tick-scoped memory of the watch loop. One service owns exactly one of these. */
export type GuardWatchState = {
  /** Consecutive starts that did not produce a live daemon. */
  failures: number;
  /** A start was issued and no check has confirmed or denied it yet. */
  awaitingStart: boolean;
  /** Epoch ms before which no new start may be issued (backoff). */
  notBeforeMs: number;
  /** A start is in flight inside this tick (re-entry guard). */
  starting: boolean;
};

export function createGuardWatchState(): GuardWatchState {
  return { failures: 0, awaitingStart: false, notBeforeMs: 0, starting: false };
}

/** 60s, 2m, 4m, 8m, then the 15m ceiling. */
export function guardWatchBackoffMs(failures: number): number {
  const steps = Math.min(Math.max(Math.trunc(failures), 1), 5);
  return Math.min(GUARD_WATCH_BACKOFF_MAX_MS, GUARD_WATCH_BACKOFF_BASE_MS * 2 ** (steps - 1));
}

export type GuardWatchSkipReason = "official" | "running" | "starting" | "awaiting-start" | "backoff";

export type GuardWatchDecision =
  | { readonly kind: "start" }
  | { readonly kind: "skip"; readonly reason: GuardWatchSkipReason; readonly retryInMs?: number };

/**
 * The whole policy, with no IO, so every rail is unit-testable: official never
 * starts anything, a live daemon needs nothing, and a cooldown, an in-flight
 * start, or an unconfirmed one all defer to the next tick.
 */
export function decideGuardWatch(input: {
  readonly mode: GuardWatchMode;
  readonly runningPid: number | undefined;
  readonly state: GuardWatchState;
  readonly nowMs: number;
}): GuardWatchDecision {
  if (input.mode === "official") {
    return { kind: "skip", reason: "official" };
  }
  if (input.runningPid !== undefined) {
    return { kind: "skip", reason: "running" };
  }
  if (input.state.starting) {
    return { kind: "skip", reason: "starting" };
  }
  if (input.state.awaitingStart) {
    return { kind: "skip", reason: "awaiting-start" };
  }
  if (input.nowMs < input.state.notBeforeMs) {
    return { kind: "skip", reason: "backoff", retryInMs: input.state.notBeforeMs - input.nowMs };
  }
  return { kind: "start" };
}

export type GuardWatchEvent = {
  readonly type: "guard.watch";
  readonly severity: "INFO" | "WARN";
  readonly message: string;
};

export type GuardWatchIo = {
  readonly mode: GuardWatchMode;
  /** Injected clock for tests. */
  readonly now?: (() => number) | undefined;
  readonly event?: ((entry: GuardWatchEvent) => void) | undefined;
  readonly log?: ((line: string) => void) | undefined;
};

export type GuardWatchOutcome =
  | { readonly kind: "skipped"; readonly reason: GuardWatchSkipReason; readonly retryInMs?: number }
  | { readonly kind: "started"; readonly pid: number }
  | { readonly kind: "failed"; readonly message: string };

function seconds(ms: number): string {
  return `${String(Math.max(1, Math.round(ms / 1000)))}s`;
}

/** Best-effort reporting: the babysitter must never take the service down. */
function report(io: GuardWatchIo, severity: "INFO" | "WARN", message: string): void {
  try {
    io.event?.({ type: "guard.watch", severity, message });
  } catch {
    /* event write is best-effort */
  }
  try {
    io.log?.(`openbot-guard-watch: ${message}\n`);
  } catch {
    /* logging is best-effort */
  }
}

/**
 * One check. Synchronous on purpose: a spawn returns immediately, so the latch
 * below plus the unconfirmed-start window is the strongest single-flight
 * guarantee available, and an overlapping tick cannot exist.
 */
export function runGuardWatchTick(deps: SupervisorDeps, state: GuardWatchState, io: GuardWatchIo): GuardWatchOutcome {
  const now = io.now?.() ?? Date.now();
  const runningPid = guardDaemonPid(deps);

  if (io.mode === "official") {
    // Official owns no custom patrol. Drop the streak so a box that returns to
    // custom starts from a clean slate instead of a stale cooldown.
    state.failures = 0;
    state.awaitingStart = false;
    state.notBeforeMs = 0;
    return { kind: "skipped", reason: "official" };
  }

  if (runningPid !== undefined) {
    if (state.failures > 0) {
      report(io, "INFO", `Guard daemon is running again (pid ${String(runningPid)}) after ${String(state.failures)} failed start(s).`);
    }
    state.failures = 0;
    state.awaitingStart = false;
    state.notBeforeMs = 0;
    return { kind: "skipped", reason: "running" };
  }

  if (state.awaitingStart) {
    // The start issued last time has had a full interval and there is still no
    // live daemon: book it as a failure and cool down before trying again.
    state.awaitingStart = false;
    state.failures += 1;
    state.notBeforeMs = now + guardWatchBackoffMs(state.failures);
    report(
      io,
      "WARN",
      `Guard daemon did not come up after a start (attempt ${String(state.failures)}); retrying in ${seconds(state.notBeforeMs - now)}.`,
    );
  }

  const decision = decideGuardWatch({ mode: io.mode, runningPid, state, nowMs: now });
  if (decision.kind === "skip") {
    return {
      kind: "skipped",
      reason: decision.reason,
      ...(decision.retryInMs !== undefined ? { retryInMs: decision.retryInMs } : {}),
    };
  }

  state.starting = true;
  try {
    const pid = startGuardDaemon(deps);
    // Unconfirmed until the next check sees the daemon's own pidfile.
    state.awaitingStart = true;
    report(io, "WARN", `Guard daemon was not running; started it (pid ${String(pid)}).`);
    return { kind: "started", pid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.failures += 1;
    state.notBeforeMs = now + guardWatchBackoffMs(state.failures);
    report(
      io,
      "WARN",
      `Could not start the guard daemon: ${message} (attempt ${String(state.failures)}); retrying in ${
        seconds(state.notBeforeMs - now)
      }.`,
    );
    return { kind: "failed", message };
  } finally {
    state.starting = false;
  }
}
