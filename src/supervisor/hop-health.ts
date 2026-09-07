import { LOOPBACK, SERVICE_PORT } from "../domain/types.ts";
import { type SupervisorDeps } from "./observe.ts";
import { joinAbs } from "./paths.ts";
import { appendGuardAudit } from "./reconcile.ts";

/**
 * Health patrol for the hop endpoint that payload/runtime.cjs actually dials.
 * hop either lives inside the UI service (custom mode, port 9280) or runs as
 * its own hop-server process on the same address, so probing the runtime's
 * target address is the single source of truth for both layouts.
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

/** Probe once; restart through the procs base once the failure streak hits
 * the threshold. The pidfile written by hop-server itself reconciles the
 * state with reconcile.ts's stopLeftoverHopOnly cleanup. */
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
  deps.fs.mkdirp(deps.paths.sandData);
  const pid = deps.procs.start({
    argv: ["--experimental-strip-types", deps.paths.hopServer],
    env: { ...process.env, ...hopServerEnv(deps, target) },
    log: deps.paths.hopLog,
    pidFile: deps.paths.hopPid,
  });
  writeFailures(deps, 0);
  appendGuardAudit(deps, { source: opts.source ?? "guard-daemon" }, "hop-down", "hop-restarted");
  return { status: "restarted", target, failures, pid };
}
