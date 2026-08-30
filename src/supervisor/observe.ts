import {
  HOP_PORT,
  LOOPBACK,
  OPENBOT_MARKER,
  UI_PORT,
  align,
  type CustomBox,
  type HostObserved,
  type OfficialBox,
  type Snapshot,
  type WrapObserved,
} from "../domain/types.ts";
import { censusHost, hasForeignOpengrokWrap } from "../host/census.ts";
import { type BoxPaths } from "./paths.ts";
import { classifyPort, type FsDeps, type ProcDeps } from "./procs.ts";

export type SupervisorDeps = {
  readonly paths: BoxPaths;
  readonly fs: FsDeps;
  readonly procs: ProcDeps;
};

export function wrapFromSource(source: string | undefined): WrapObserved {
  if (source === undefined) {
    return { kind: "stock-unmarked" };
  }
  if (hasForeignOpengrokWrap(source)) {
    return { kind: "foreign-opengrok" };
  }
  const census = censusHost(source);
  switch (census.kind) {
    case "already-openbot":
      return { kind: "openbot-marked", marker: OPENBOT_MARKER };
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
    uiListen: { kind: "loopback", host: LOOPBACK, port: UI_PORT },
    secretsPath: paths.secrets,
  };
}

function customStub(paths: BoxPaths): CustomBox {
  return {
    kind: "custom",
    wrap: { kind: "marked", marker: OPENBOT_MARKER },
    hopListen: { kind: "adopt-or-start", host: LOOPBACK, port: HOP_PORT },
    uiListen: { kind: "loopback", host: LOOPBACK, port: UI_PORT },
    secretsPath: paths.secrets,
    catalog: { providers: [], models: [], bindings: [] },
    hop: { host: LOOPBACK, port: HOP_PORT },
  };
}

export async function observe(deps: SupervisorDeps): Promise<Snapshot> {
  const source = deps.fs.read(deps.paths.hostMain);
  const wrap = wrapFromSource(source);
  const desired = deps.fs.exists(deps.paths.plan) ? customStub(deps.paths) : officialStub(deps.paths);
  const hopPid = deps.procs.readPidFile(deps.paths.hopPid);
  const uiPid = deps.procs.readPidFile(deps.paths.uiPid);
  const hopListen = classifyPort({
    listening: await deps.procs.port(LOOPBACK, HOP_PORT),
    pidFile: hopPid,
    pidAlive: hopPid !== undefined && deps.procs.pidAlive(hopPid),
    host: LOOPBACK,
    port: HOP_PORT,
  });
  const uiListen = classifyPort({
    listening: await deps.procs.port(LOOPBACK, UI_PORT),
    pidFile: uiPid,
    pidAlive: uiPid !== undefined && deps.procs.pidAlive(uiPid),
    host: LOOPBACK,
    port: UI_PORT,
  });
  const hostPids = deps.procs.hostPids(deps.paths.hostMain);
  const host: HostObserved =
    hostPids[0] !== undefined ? { kind: "running-owned", pid: hostPids[0] } : { kind: "absent" };
  return { wrap, hopListen, uiListen, host, alignment: align(desired, wrap) };
}
