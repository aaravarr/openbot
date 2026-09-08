import { LOOPBACK, SERVICE_PORT } from "../domain/types.ts";
import { type SupervisorDeps } from "./observe.ts";
import { joinAbs } from "./paths.ts";
import { parseOwnedPid } from "./procs.ts";
import { appendGuardAudit } from "./reconcile.ts";

/**
 * Health patrol for the hop endpoint that payload/runtime.cjs actually dials.
 *
 * Two deployment layouts share this patrol:
 *
 * - Unified (the current main layout): the UI service (src/ui/server.ts)
 *   listens on SERVICE_PORT (9280) and the hop handler runs as a route in
 *   that same process. A dark 9280 means the UI process is down, so the
 *   repair restarts the UI service. Spawning payload/hop-server.cjs onto
 *   9280 here is forbidden: it wins the bind race, the UI then dies with
 *   EADDRINUSE, and /api/* goes 404 while only the hop route answers.
 * - Standalone: payload/hop-server.cjs runs as its own process on the
 *   OPENBOT_HOP_PORT address (for example 18790), independently of the UI.
 */

export type HopTarget = { readonly host: string; readonly port: number };

/** Mirror of payload/runtime.cjs hopUrl(): read the same env vars. */
export function hopTargetFromEnv(env: NodeJS.ProcessEnv = process.env): HopTarget {
  const host = env.OPENBOT_HOP_HOST || LOOPBACK;
  const raw = Number(env.OPENBOT_HOP_PORT || SERVICE_PORT);
  const port = Number.isInteger(raw) && raw > 0 ? raw : SERVICE_PORT;
  return { host, port };
}

export const DEFAULT_HOP_FAILURE_THRESHOLD = 2;

const HOP_HEALTH_STATE_FILE = "openbot-hop-health.json";

export type HopHealthStatus = "healthy" | "degraded" | "restarted";

export type HopHealthResult = {
  readonly status: HopHealthStatus;
  readonly target: HopTarget;
  /** Consecutive probe failures counted before this tick's action. */
  readonly failures: number;
  readonly pid?: number | undefined;
};

export type HopHealthOpts = {
  readonly target?: HopTarget;
  readonly failureThreshold?: number;
  /** Written on the audit line when the patrol restarts hop. */
  readonly source?: string;
};

function statePath(deps: SupervisorDeps) {
  return joinAbs(deps.paths.sandData, HOP_HEALTH_STATE_FILE);
}

function readFailures(deps: SupervisorDeps): number {
  try {
    const raw = deps.fs.read(statePath(deps));
    if (raw === undefined) return 0;
    const parsed = JSON.parse(raw) as { failures?: unknown };
    const value = Number(parsed.failures);
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeFailures(deps: SupervisorDeps, failures: number): void {
  try {
    deps.fs.write(statePath(deps), JSON.stringify({ failures }), 0o644);
  } catch {
    /* the counter is best-effort; a stuck counter must not kill the tick */
  }
}

function hopServerEnv(deps: SupervisorDeps, target: HopTarget): NodeJS.ProcessEnv {
  return {
    OPENBOT_HOST_MAIN: deps.paths.hostMain,
    OPENBOT_SAND_DATA: deps.paths.sandData,
    OPENBOT_REPO: deps.paths.repoRoot,
    OPENBOT_PLAN: deps.paths.plan,
    OPENBOT_SECRETS: deps.paths.secrets,
    OPENBOT_MAPS: deps.paths.maps,
    OPENBOT_LOGS: deps.paths.logsSettings,
    OPENBOT_HOP_HOST: target.host,
    OPENBOT_HOP_PORT: String(target.port),
    OPENBOT_HOP_PID: deps.paths.hopPid,
  };
}

/**
 * Unified vs standalone deployment check.
 *
 * The reliable signal is the probe target's port plus the explicit hop-port
 * env: reconcile.ts only ever starts the UI service (startService runs
 * uiServer with uiPid/uiLog) on SERVICE_PORT, and the hop handler runs as a
 * route inside that same process (server.ts handleHopRequest); install.sh
 * notes "Unified UI mode has no standalone hop", and AGENTS.md forbids
 * spawning hop-server next to the UI. A standalone hop only exists when
 * OPENBOT_HOP_PORT points at a different port (for example 18790).
 *
 * Deliberately not based on pidfiles: hopPid/uiPid are runtime state that
 * reconcile.ts cleans up (stopLeftoverHopOnly), and a leftover hop.pid from
 * this very bug (hop-server squatting 9280) would misclassify unified as
 * standalone and keep respawning the squatter.
 */
export function isUnifiedHopTarget(
  target: HopTarget,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (target.port !== SERVICE_PORT) {
    return false;
  }
  const raw = env.OPENBOT_HOP_PORT;
  if (raw !== undefined && raw !== "") {
    const explicit = Number(raw);
    if (Number.isInteger(explicit) && explicit > 0 && explicit !== SERVICE_PORT) {
      return false;
    }
  }
  return true;
}

/** Env for restarting the UI service; mirrors reconcile.ts sharedEnv but honors the probed target. */
function uiServiceEnv(deps: SupervisorDeps, target: HopTarget): NodeJS.ProcessEnv {
  return {
    OPENBOT_HOST_MAIN: deps.paths.hostMain,
    OPENBOT_SAND_DATA: deps.paths.sandData,
    OPENBOT_REPO: deps.paths.repoRoot,
    OPENBOT_PLAN: deps.paths.plan,
    OPENBOT_SECRETS: deps.paths.secrets,
    OPENBOT_MAPS: deps.paths.maps,
    OPENBOT_LOGS: deps.paths.logsSettings,
    OPENBOT_HOP_HOST: target.host,
    OPENBOT_HOP_PORT: String(target.port),
    OPENBOT_HOP_PID: deps.paths.hopPid,
    OPENBOT_UI_HOST: target.host,
    OPENBOT_UI_PORT: String(target.port),
    OPENBOT_UI_PID: deps.paths.uiPid,
  };
}

/**
 * Restart a standalone hop process on the probed port. This path only runs
 * when the target is NOT the unified UI port (see isUnifiedHopTarget): the
 * hop owns its own listener there, so nothing else can win the bind.
 * The pidfile written by hop-server itself reconciles the state with
 * reconcile.ts's stopLeftoverHopOnly cleanup.
 */
function restartStandaloneHop(deps: SupervisorDeps, target: HopTarget): number {
  deps.fs.mkdirp(deps.paths.sandData);
  return deps.procs.start({
    argv: ["--experimental-strip-types", deps.paths.hopServer],
    env: { ...process.env, ...hopServerEnv(deps, target) },
    log: deps.paths.hopLog,
    pidFile: deps.paths.hopPid,
  });
}

/**
 * Repair a dark unified port by restarting the UI service process. The hop
 * handler is a route inside that process (server.ts handleHopRequest), so
 * restarting the UI IS restarting the hop. Spawning payload/hop-server.cjs
 * here would squat 9280 and kill the UI with EADDRINUSE; this function
 * never does that.
 *
 * Anti-flap order: re-check the port first (reconcile may already be
 * restarting the UI), then SIGTERM a still-listed-but-deaf UI pid before
 * starting a fresh one so two UI processes never race for the bind.
 *
 * Returns the new UI pid, or undefined when the port recovered before a
 * start was needed (no restart happened; the caller reports healthy).
*/
async function restartUnifiedUiService(
  deps: SupervisorDeps,
  target: HopTarget,
): Promise<number | undefined> {
  if (await deps.procs.port(target.host, target.port)) {
    return undefined;
  }
  deps.fs.mkdirp(deps.paths.sandData);
  const staleUi = deps.procs.readPidFile(deps.paths.uiPid);
  if (staleUi !== undefined && deps.procs.pidAlive(staleUi)) {
    deps.procs.stop(parseOwnedPid(staleUi));
    deps.fs.remove(deps.paths.uiPid);
  }
  if (await deps.procs.port(target.host, target.port)) {
    return undefined;
  }
  return deps.procs.start({
    argv: ["--experimental-strip-types", deps.paths.uiServer],
    env: { ...process.env, ...uiServiceEnv(deps, target) },
    log: deps.paths.uiLog,
    pidFile: deps.paths.uiPid,
  });
}

/** Probe once; restart through the procs base once the failure streak hits
 * the threshold. Unified targets restart the UI service (the hop route
 * lives inside it); standalone targets restart hop-server on its own port. */
export async function runHopHealthCheck(
  deps: SupervisorDeps,
  opts: HopHealthOpts = {},
): Promise<HopHealthResult> {
  const target = opts.target ?? hopTargetFromEnv();
  const threshold = opts.failureThreshold ?? DEFAULT_HOP_FAILURE_THRESHOLD;
  const listening = await deps.procs.port(target.host, target.port);
  if (listening) {
    writeFailures(deps, 0);
    return { status: "healthy", target, failures: 0, pid: undefined };
  }
  const failures = readFailures(deps) + 1;
  if (failures < threshold) {
    writeFailures(deps, failures);
    return { status: "degraded", target, failures, pid: undefined };
  }
  if (isUnifiedHopTarget(target)) {
    const pid = await restartUnifiedUiService(deps, target);
    if (pid === undefined) {
      // Re-check saw the port back (reconcile restarted the UI concurrently):
      // report healthy so the patrol does not claim a restart it did not do.
      writeFailures(deps, 0);
      return { status: "healthy", target, failures: 0, pid: undefined };
    }
    writeFailures(deps, 0);
    appendGuardAudit(deps, { source: opts.source ?? "guard-daemon" }, "hop-down", "ui-restarted");
    return { status: "restarted", target, failures, pid };
  }
  const pid = restartStandaloneHop(deps, target);
  writeFailures(deps, 0);
  appendGuardAudit(deps, { source: opts.source ?? "guard-daemon" }, "hop-down", "hop-restarted");
  return { status: "restarted", target, failures, pid };
}
