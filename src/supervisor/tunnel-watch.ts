import { type Expose } from "../domain/types.ts";
import {
  downloadHttps,
  readTunnelCache,
  startQuickTunnel,
  type TunnelDeps,
  type TunnelNet,
} from "./tunnel.ts";

/**
 * Keep the public link alive.
 *
 * A cloudflared quick tunnel is the only way the user reaches this box from a
 * phone, and nothing brought it back when it died: reconcile only ever starts
 * a tunnel when there is none to adopt, and no timer looked at it afterwards.
 * A crash, an OOM kill, or a reboot therefore ended the link until a human ran
 * `openbot tunnel on` again.
 *
 * The long-running loopback service (src/ui/server.ts) owns this bounded
 * babysitter, the same way it owns guard-watch.ts. Rail by rail, in the order
 * they can fire:
 *
 * - Never on official. Official is the user's "stay on stock Grok" state and
 *   that state does not resurrect a custom box's public URL by itself; a
 *   tunnel started here would also reopen the control page to the internet
 *   behind the user's back. An explicit `openbot tunnel on` still starts one.
 * - Never while the expose is loopback. `openbot tunnel off` means off, and a
 *   babysitter that restarts cloudflared there would fight the user.
 * - Only when the tunnel is really gone. `readTunnelCache` is the whole test:
 *   the cached hostname belongs to the cloudflared process that booked it, so
 *   a live pid means the link is valid -- no public probe, ever. (Probing is
 *   what used to rotate healthy URLs; see reconcileExpose.)
 * - Never two at once. The start runs inside the tick and the state carries a
 *   re-entry latch, so an interval that fires while a start is still waiting
 *   for its hostname cannot spawn a second cloudflared.
 * - Bounded retries. Consecutive failures double the wait up to
 *   TUNNEL_WATCH_BACKOFF_MAX_MS, so a box that cannot start cloudflared
 *   (offline, corporate DNS) cannot become a spawn loop.
 * - Observable. Every recovery and failure appends a tunnel.watch event to the
 *   events channel (and one line to the service's stderr). tunnel.ts adds the
 *   tunnel.start/tunnel.rotate row carrying the old and new URL.
 *
 * The mode is an input, not read here: src/ui/server.ts already owns the
 * strict rule (wrapMode: only the literal token "official" means official) and
 * a second copy of it would be a second thing to keep in step.
 */

/** How often the service checks that the quick tunnel is still alive. */
export const TUNNEL_WATCH_INTERVAL_MS = 60_000;
/**
 * The first check waits this long. install.sh starts its own tunnel right after
 * the install reconcile -- the same reconcile that restarts this service -- and
 * that start must win, or every normal install would be reported (and raced) as
 * a recovery.
 */
export const TUNNEL_WATCH_STARTUP_DELAY_MS = 60_000;
/** Wait after a failed start; doubles per consecutive failure. */
export const TUNNEL_WATCH_BACKOFF_BASE_MS = 60_000;
/** Ceiling for that backoff: at most one attempt per 15 minutes. */
export const TUNNEL_WATCH_BACKOFF_MAX_MS = 15 * 60_000;
/** `OPENBOT_TUNNEL_WATCH=0` turns the babysitter off. `openbot tunnel on` still works. */
export const TUNNEL_WATCH_DISABLE_ENV = "OPENBOT_TUNNEL_WATCH";

export type TunnelWatchMode = "official" | "custom";

/** Tick-scoped memory of the watch loop. One service owns exactly one of these. */
export type TunnelWatchState = {
  /** Consecutive starts that did not produce a live tunnel. */
  failures: number;
  /** Epoch ms before which no new start may be issued (backoff). */
  notBeforeMs: number;
  /** A start is in flight inside this tick (re-entry guard). */
  starting: boolean;
};

export function createTunnelWatchState(): TunnelWatchState {
  return { failures: 0, notBeforeMs: 0, starting: false };
}

/** 60s, 2m, 4m, 8m, then the 15m ceiling. */
export function tunnelWatchBackoffMs(failures: number): number {
  const steps = Math.min(Math.max(Math.trunc(failures), 1), 5);
  return Math.min(TUNNEL_WATCH_BACKOFF_MAX_MS, TUNNEL_WATCH_BACKOFF_BASE_MS * 2 ** (steps - 1));
}

export type TunnelWatchSkipReason = "official" | "loopback" | "running" | "starting" | "backoff";

export type TunnelWatchDecision =
  | { readonly kind: "start" }
  | { readonly kind: "skip"; readonly reason: TunnelWatchSkipReason; readonly retryInMs?: number };

/**
 * The whole policy, with no IO, so every rail is unit-testable: official never
 * starts anything, a loopback expose is left alone, a live tunnel needs
 * nothing, and a cooldown or an in-flight start both defer to the next tick.
 */
export function decideTunnelWatch(input: {
  readonly mode: TunnelWatchMode;
  readonly expose: Expose;
  readonly running: boolean;
  readonly state: TunnelWatchState;
  readonly nowMs: number;
}): TunnelWatchDecision {
  if (input.mode === "official") {
    return { kind: "skip", reason: "official" };
  }
  if (input.expose.kind !== "cloudflare-quick") {
    return { kind: "skip", reason: "loopback" };
  }
  if (input.running) {
    return { kind: "skip", reason: "running" };
  }
  if (input.state.starting) {
    return { kind: "skip", reason: "starting" };
  }
  if (input.nowMs < input.state.notBeforeMs) {
    return { kind: "skip", reason: "backoff", retryInMs: input.state.notBeforeMs - input.nowMs };
  }
  return { kind: "start" };
}

export type TunnelWatchEvent = {
  readonly type: "tunnel.watch";
  readonly severity: "INFO" | "WARN";
  readonly message: string;
};

export type TunnelWatchIo = {
  readonly mode: TunnelWatchMode;
  readonly expose: Expose;
  /** Injected clock for tests. */
  readonly now?: (() => number) | undefined;
  readonly event?: ((entry: TunnelWatchEvent) => void) | undefined;
  readonly log?: ((line: string) => void) | undefined;
  /** Injected transport for tests: the real one downloads cloudflared when absent. */
  readonly net?: TunnelNet | undefined;
};

export type TunnelWatchOutcome =
  | { readonly kind: "skipped"; readonly reason: TunnelWatchSkipReason; readonly retryInMs?: number }
  | { readonly kind: "started"; readonly url: string; readonly pid: number }
  | { readonly kind: "failed"; readonly message: string };

function seconds(ms: number): string {
  return `${String(Math.max(1, Math.round(ms / 1000)))}s`;
}

/** Best-effort reporting: the babysitter must never take the service down. */
function report(io: TunnelWatchIo, severity: "INFO" | "WARN", message: string): void {
  try {
    io.event?.({ type: "tunnel.watch", severity, message });
  } catch {
    /* event write is best-effort */
  }
  try {
    io.log?.(`openbot-tunnel-watch: ${message}\n`);
  } catch {
    /* logging is best-effort */
  }
}

/**
 * One check. Asynchronous because a restart spawns cloudflared and waits for
 * its hostname, so unlike the guard's tick this one can overlap the next
 * interval; the `starting` latch taken before the first await is what keeps a
 * slow start single-flight.
 */
export async function runTunnelWatchTick(
  deps: TunnelDeps,
  state: TunnelWatchState,
  io: TunnelWatchIo,
): Promise<TunnelWatchOutcome> {
  const now = io.now?.() ?? Date.now();

  if (io.mode === "official" || io.expose.kind !== "cloudflare-quick") {
    // Drop the streak so a box that comes back to a quick tunnel starts from a
    // clean slate instead of a stale cooldown.
    state.failures = 0;
    state.notBeforeMs = 0;
    return { kind: "skipped", reason: io.mode === "official" ? "official" : "loopback" };
  }

  const cached = readTunnelCache(deps);
  if (cached.kind === "cloudflare-quick") {
    if (state.failures > 0) {
      report(
        io,
        "INFO",
        `Cloudflare Tunnel is serving again (${cached.url}) after ${String(state.failures)} failed restart(s).`,
      );
    }
    state.failures = 0;
    state.notBeforeMs = 0;
    return { kind: "skipped", reason: "running" };
  }

  if (state.starting) {
    return { kind: "skipped", reason: "starting" };
  }

  const decision = decideTunnelWatch({
    mode: io.mode,
    expose: io.expose,
    running: false,
    state,
    nowMs: now,
  });
  if (decision.kind === "skip") {
    return {
      kind: "skipped",
      reason: decision.reason,
      ...(decision.retryInMs !== undefined ? { retryInMs: decision.retryInMs } : {}),
    };
  }

  state.starting = true;
  try {
    const observed = await startQuickTunnel(deps, io.net ?? { download: downloadHttps });
    if (observed.kind !== "cloudflare-quick") {
      const message = observed.kind === "error" ? observed.message : "Cloudflare Tunnel did not come up";
      state.failures += 1;
      state.notBeforeMs = now + tunnelWatchBackoffMs(state.failures);
      report(
        io,
        "WARN",
        `Cloudflare Tunnel did not come back: ${message} (attempt ${String(state.failures)}); retrying in ${
          seconds(state.notBeforeMs - now)
        }.`,
      );
      return { kind: "failed", message };
    }
    state.failures = 0;
    state.notBeforeMs = 0;
    report(
      io,
      "WARN",
      `Cloudflare Tunnel was down; cloudflared is up again and published ${observed.url} (pid ${String(observed.pid)}).`,
    );
    return { kind: "started", url: observed.url, pid: observed.pid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.failures += 1;
    state.notBeforeMs = now + tunnelWatchBackoffMs(state.failures);
    report(
      io,
      "WARN",
      `Could not restart cloudflared: ${message} (attempt ${String(state.failures)}); retrying in ${
        seconds(state.notBeforeMs - now)
      }.`,
    );
    return { kind: "failed", message };
  } finally {
    state.starting = false;
  }
}
