import {
  HOP_PORT,
  LOOPBACK,
  OPENBOT_MARKER,
  UI_PORT,
  type DesiredState,
  type Snapshot,
} from "../domain/types.ts";
import { censusHost } from "../host/census.ts";
import { peelOpengrokToStock, proveWrap, stripWrap, wrapHostSource } from "../host/wrap.ts";
import { observe, wrapFromSource, type SupervisorDeps } from "./observe.ts";
import { compileCustomPlan, planToJson } from "./plan.ts";
import { writeTemp } from "./procs.ts";

export type ReconcileError =
  | { readonly kind: "host-missing"; readonly path: string }
  | { readonly kind: "foreign-hop" }
  | { readonly kind: "foreign-ui" }
  | { readonly kind: "foreign-opengrok" }
  | { readonly kind: "census-refused"; readonly reason: string }
  | { readonly kind: "syntax-check-failed"; readonly stderr: string };

export type ReconcileResult =
  | { readonly kind: "ok"; readonly snapshot: Snapshot; readonly wrapBytesChanged: boolean }
  | { readonly kind: "refused"; readonly error: ReconcileError };

export type SharedEnv = {
  readonly OPENBOT_HOST_MAIN: string;
  readonly OPENBOT_SAND_DATA: string;
  readonly OPENBOT_REPO: string;
  readonly OPENBOT_PLAN: string;
  readonly OPENBOT_SECRETS: string;
  readonly OPENBOT_MAPS: string;
  readonly OPENBOT_HOP_HOST: string;
  readonly OPENBOT_HOP_PORT: string;
  readonly OPENBOT_HOP_PID: string;
  readonly OPENBOT_UI_HOST: string;
  readonly OPENBOT_UI_PORT: string;
  readonly OPENBOT_UI_PID: string;
};

function sharedEnv(deps: SupervisorDeps): SharedEnv {
  return {
    OPENBOT_HOST_MAIN: deps.paths.hostMain,
    OPENBOT_SAND_DATA: deps.paths.sandData,
    OPENBOT_REPO: deps.paths.repoRoot,
    OPENBOT_PLAN: deps.paths.plan,
    OPENBOT_SECRETS: deps.paths.secrets,
    OPENBOT_MAPS: deps.paths.maps,
    OPENBOT_HOP_HOST: LOOPBACK,
    OPENBOT_HOP_PORT: String(HOP_PORT),
    OPENBOT_HOP_PID: deps.paths.hopPid,
    OPENBOT_UI_HOST: LOOPBACK,
    OPENBOT_UI_PORT: String(UI_PORT),
    OPENBOT_UI_PID: deps.paths.uiPid,
  };
}

async function bounceHostIfNeeded(deps: SupervisorDeps, wrapBytesChanged: boolean): Promise<void> {
  if (!wrapBytesChanged) {
    return;
  }
  const pids = deps.procs.hostPids(deps.paths.hostMain);
  for (const pid of pids) {
    deps.procs.term(pid);
  }
}

function startUi(deps: SupervisorDeps): void {
  deps.fs.mkdirp(deps.paths.sandData);
  deps.procs.start({
    argv: ["--experimental-strip-types", deps.paths.uiServer],
    env: { ...process.env, ...sharedEnv(deps) },
    log: deps.paths.uiLog,
    pidFile: deps.paths.uiPid,
  });
}

function startHop(deps: SupervisorDeps): void {
  deps.fs.mkdirp(deps.paths.sandData);
  deps.procs.start({
    argv: [deps.paths.hopServer],
    env: { ...process.env, ...sharedEnv(deps) },
    log: deps.paths.hopLog,
    pidFile: deps.paths.hopPid,
  });
}

function restoreOfficialHost(deps: SupervisorDeps, source: string): boolean {
  const peeled = peelOpengrokToStock(source);
  if (peeled.kind === "stock" && peeled.source !== source) {
    deps.fs.write(deps.paths.hostMain, peeled.source, 0o644);
    return true;
  }
  if (!source.includes(OPENBOT_MARKER)) {
    return false;
  }
  const backup = deps.fs.read(deps.paths.knownBackup);
  const restored = backup !== undefined ? backup : stripWrap(source);
  if (restored === source) {
    return false;
  }
  deps.fs.write(deps.paths.hostMain, restored, 0o644);
  return true;
}

function installCustomWrap(deps: SupervisorDeps, source: string): ReconcileResult | { changed: boolean } {
  if (source.includes(OPENBOT_MARKER)) {
    return { changed: false };
  }
  const proof = wrapHostSource({ source, runtimePath: deps.paths.runtime });
  if (proof.kind === "refused") {
    return { kind: "refused", error: { kind: "census-refused", reason: proof.reason } };
  }
  if (proof.kind === "already-marked") {
    return { changed: false };
  }
  deps.fs.mkdirp(deps.paths.sandData);
  deps.fs.write(deps.paths.knownBackup, source, 0o644);
  // Node treats the last suffix as the module type. A name ending in
  // .openbot-check makes `node --check` fail on current Node.
  const tmp = writeTemp(deps.fs, deps.paths.sandData, "host-main.openbot-check.cjs", proof.source);
  const check = deps.procs.syntaxCheck(tmp);
  deps.fs.remove(tmp);
  if (!check.ok) {
    return { kind: "refused", error: { kind: "syntax-check-failed", stderr: check.stderr } };
  }
  deps.fs.write(deps.paths.hostMain, proof.source, 0o644);
  return { changed: true };
}

export function dryRunWrap(
  deps: SupervisorDeps,
): ReconcileResult | { kind: "proof"; proof: ReturnType<typeof proveWrap> } {
  const source = deps.fs.read(deps.paths.hostMain);
  if (source === undefined) {
    return { kind: "refused", error: { kind: "host-missing", path: deps.paths.hostMain } };
  }
  const peeled = peelOpengrokToStock(source);
  const forProof = peeled.kind === "stock" ? peeled.source : source;
  return { kind: "proof", proof: proveWrap({ source: forProof, runtimePath: deps.paths.runtime }) };
}

export async function reconcile(desired: DesiredState, deps: SupervisorDeps): Promise<ReconcileResult> {
  const raw = deps.fs.read(deps.paths.hostMain);
  if (raw === undefined) {
    return { kind: "refused", error: { kind: "host-missing", path: deps.paths.hostMain } };
  }

  const peeled = peelOpengrokToStock(raw);
  if (wrapFromSource(raw).kind === "foreign-opengrok" && peeled.kind === "still-foreign") {
    return { kind: "refused", error: { kind: "foreign-opengrok" } };
  }
  const source = peeled.kind === "stock" ? peeled.source : raw;

  const before = await observe(deps);
  let hopListen = before.hopListen;
  if (desired.kind === "custom" && hopListen.kind === "foreign") {
    const leftovers = deps.procs.opengrokHopPids();
    if (leftovers.length === 0) {
      return { kind: "refused", error: { kind: "foreign-hop" } };
    }
    for (const pid of leftovers) {
      deps.procs.stop(pid);
    }
    hopListen = { kind: "absent" };
  }
  if (before.uiListen.kind === "foreign") {
    return { kind: "refused", error: { kind: "foreign-ui" } };
  }

  deps.fs.mkdirp(deps.paths.sandData);
  let wrapBytesChanged = false;

  if (desired.kind === "official") {
    wrapBytesChanged = restoreOfficialHost(deps, raw);
    deps.fs.remove(deps.paths.plan);
    if (hopListen.kind === "ours") {
      deps.procs.stop(hopListen.pid);
      deps.fs.remove(deps.paths.hopPid);
    }
    if (before.uiListen.kind === "absent") {
      startUi(deps);
    }
    await bounceHostIfNeeded(deps, wrapBytesChanged);
    return { kind: "ok", snapshot: await observe(deps), wrapBytesChanged };
  }

  const census = censusHost(source);
  if (census.kind === "private-lane" || census.kind === "gap" || census.kind === "ambiguous-factory") {
    return {
      kind: "refused",
      error: { kind: "census-refused", reason: `cannot wrap a ${census.kind} host` },
    };
  }

  const wrapped = installCustomWrap(deps, source);
  if ("kind" in wrapped) {
    return wrapped;
  }
  wrapBytesChanged = wrapped.changed || raw !== source;
  deps.fs.write(deps.paths.plan, planToJson(compileCustomPlan(desired)), 0o644);

  if (hopListen.kind === "absent") {
    startHop(deps);
  }
  if (before.uiListen.kind === "absent") {
    startUi(deps);
  }
  await bounceHostIfNeeded(deps, wrapBytesChanged);
  return { kind: "ok", snapshot: await observe(deps), wrapBytesChanged };
}
