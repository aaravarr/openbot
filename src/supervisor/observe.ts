import {
  LOOPBACK,
  OPENBOT_MARKER,
  SERVICE_PORT,
  align,
  loopbackExpose,
  type CustomBox,
  type HostObserved,
  type OfficialBox,
  type Snapshot,
  type WrapObserved,
} from "../domain/types.ts";
import { censusHost } from "../host/census.ts";
import { type BoxPaths } from "./paths.ts";
import { classifyPort, type FsDeps, type ProcDeps } from "./procs.ts";
import { readTunnelCache } from "./tunnel.ts";

export type SupervisorDeps = {
  readonly paths: BoxPaths;
  readonly fs: FsDeps;
  readonly procs: ProcDeps;
};

export function wrapFromSource(source: string | undefined): WrapObserved {
  if (source === undefined) {
    return { kind: "stock-unmarked" };
  }
  const census = censusHost(source);
  switch (census.kind) {
    case "already-openbot":
      return { kind: "openbot-marked", marker: OPENBOT_MARKER };
    case "foreign-opengrok":
      return { kind: "foreign-opengrok" };
    case "stock":
      return { kind: "stock-unmarked" };
    case "private-lane":
      return { kind: "private-lane" };
    case "gap":
      return { kind: "gap", present: census.present, missing: census.missing };
    case "ambiguous-factory":
      return {
        kind: "ambiguous-factory",
        functionDefs: census.functionDefs,
        propertyDefs: census.propertyDefs,
      };
    default: {
      const _exhaustive: never = census;
      return _exhaustive;
    }
  }
}

function officialStub(paths: BoxPaths): OfficialBox {
  return {
    kind: "official",
    wrap: { kind: "stock" },
    hopListen: { kind: "stop-owned" },
    uiListen: { kind: "loopback", host: LOOPBACK, port: SERVICE_PORT },
    secretsPath: paths.secrets,
    expose: loopbackExpose(),
  };
}

function customStub(paths: BoxPaths): CustomBox {
  return {
    kind: "custom",
    wrap: { kind: "marked", marker: OPENBOT_MARKER },
    hopListen: { kind: "adopt-or-start", host: LOOPBACK, port: SERVICE_PORT },
    uiListen: { kind: "loopback", host: LOOPBACK, port: SERVICE_PORT },
    secretsPath: paths.secrets,
    catalog: { providers: [], models: [], bindings: [] },
    hop: { host: LOOPBACK, port: SERVICE_PORT },
    expose: loopbackExpose(),
  };
}

function desiredFromMode(deps: SupervisorDeps): OfficialBox | CustomBox {
  const raw = deps.fs.read(deps.paths.mode)?.trim();
  if (raw === "custom") {
    return customStub(deps.paths);
  }
  if (raw === "official") {
    return officialStub(deps.paths);
  }
  return deps.fs.exists(deps.paths.plan) ? customStub(deps.paths) : officialStub(deps.paths);
}

export async function observe(deps: SupervisorDeps): Promise<Snapshot> {
  const source = deps.fs.read(deps.paths.hostMain);
  const wrap = wrapFromSource(source);
  const desired = desiredFromMode(deps);
  const uiPid = deps.procs.readPidFile(deps.paths.uiPid);
  const service = classifyPort({
    listening: await deps.procs.port(LOOPBACK, SERVICE_PORT),
    pidFile: uiPid,
    pidAlive: uiPid !== undefined && deps.procs.pidAlive(uiPid),
    host: LOOPBACK,
    port: SERVICE_PORT,
  });
  const hostPids = deps.procs.hostPids(deps.paths.hostMain);
  const host: HostObserved =
    hostPids[0] !== undefined ? { kind: "running-owned", pid: hostPids[0] } : { kind: "absent" };
  return {
    wrap,
    hopListen: service,
    uiListen: service,
    host,
    alignment: align(desired, wrap),
    tunnel: readTunnelCache(deps),
  };
}
