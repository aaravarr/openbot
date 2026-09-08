import {
  LOOPBACK,
  OPENBOT_MARKER,
  SERVICE_PORT,
  type AbsPath,
  type DesiredState,
  type Snapshot,
} from "../domain/types.ts";
import { censusHost } from "../host/census.ts";
import { payloadFingerprint } from "../host/payload-fingerprint.ts";
import {
  extractPayloadFingerprint,
  peelOpengrokToStock,
  proveWrap,
  refreshPayloadStamp,
  stripWrap,
  wrapHostSource,
} from "../host/wrap.ts";
import { observe, wrapFromSource, type SupervisorDeps } from "./observe.ts";
import { compileCustomPlan, planToJson } from "./plan.ts";
import { parseOwnedPid, writeTemp } from "./procs.ts";
import { joinAbs } from "./paths.ts";
import { reconcileExpose } from "./tunnel.ts";

export type ReconcileError =
  | { readonly kind: "host-missing"; readonly path: string }
  | { readonly kind: "foreign-hop" }
  | { readonly kind: "foreign-ui" }
  | { readonly kind: "foreign-opengrok" }
  | { readonly kind: "census-refused"; readonly reason: string }
  | { readonly kind: "syntax-check-failed"; readonly stderr: string }
  | { readonly kind: "listen-failed"; readonly port: number };

export type ReconcileResult =
  | { readonly kind: "ok"; readonly snapshot: Snapshot; readonly wrapBytesChanged: boolean }
  | { readonly kind: "refused"; readonly error: ReconcileError };

export type ReconcileOpts = {
  /** CLI install copies a new tree. Restart the owned loopback process so it loads that tree. */
  readonly reloadService?: boolean;
  /** Who asked for this reconcile; recorded on every audit line. */
  readonly source?: string;
};

export type SharedEnv = {
  readonly OPENBOT_HOST_MAIN: string;
  readonly OPENBOT_SAND_DATA: string;
  readonly OPENBOT_REPO: string;
  readonly OPENBOT_PLAN: string;
  readonly OPENBOT_SECRETS: string;
  readonly OPENBOT_MAPS: string;
  readonly OPENBOT_LOGS: string;
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
    OPENBOT_LOGS: deps.paths.logsSettings,
    OPENBOT_HOP_HOST: LOOPBACK,
    OPENBOT_HOP_PORT: String(SERVICE_PORT),
    OPENBOT_HOP_PID: deps.paths.hopPid,
    OPENBOT_UI_HOST: LOOPBACK,
    OPENBOT_UI_PORT: String(SERVICE_PORT),
    OPENBOT_UI_PID: deps.paths.uiPid,
  };
}

export type AuditAction = "backup" | "mode" | "plan" | "wrap" | "guard";

type AuditEntry = {
  readonly ts: string;
  readonly action: AuditAction;
  readonly from: string;
  readonly to: string;
  readonly source: string;
};

function auditPath(deps: SupervisorDeps): AbsPath {
  return joinAbs(deps.paths.sandData, "openbot-audit.jsonl");
}

function fileState(deps: SupervisorDeps, path: AbsPath): string {
  return deps.fs.read(path) === undefined ? "absent" : "present";
}

/**
 * Best-effort audit trail for user-owned state (mode, plan, wrap, backup).
 * An audit failure is swallowed: it must never break or block a reconcile.
 */
function appendAudit(
  deps: SupervisorDeps,
  opts: ReconcileOpts,
  action: AuditAction,
  from: string,
  to: string,
): void {
  try {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      action,
      from,
      to,
      source: opts.source ?? "unknown",
    };
    const path = auditPath(deps);
    const existing = deps.fs.read(path);
    deps.fs.write(path, `${existing ?? ""}${JSON.stringify(entry)}\n`, 0o644);
  } catch {
    /* audit is best-effort */
  }
}

/**
 * One summary audit line for a guard repair, through the same append-only
 * mechanism as every reconcile write. `from` names what had drifted
 * (for example `mode-drift+wrap-drift`); `to` is always `custom`.
 */
export function appendGuardAudit(deps: SupervisorDeps, opts: ReconcileOpts, from: string, to: string): void {
  appendAudit(deps, opts, "guard", from, to);
}

function writeMode(deps: SupervisorDeps, kind: "official" | "custom", opts: ReconcileOpts): void {
  const from = deps.fs.read(deps.paths.mode)?.trim() ?? "absent";
  deps.fs.write(deps.paths.mode, `${kind}\n`, 0o644);
  appendAudit(deps, opts, "mode", from, kind);
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

/**
 * Hash of the payload tree that executes inside the host process. The wrap
 * header only embeds the runtime path, so without this a payload deploy
 * leaves the header byte-identical and the stale host is never bounced.
 */
function currentPayloadFingerprint(deps: SupervisorDeps): string {
  const payloadDir = joinAbs(deps.paths.repoRoot, "payload");
  return payloadFingerprint({
    payloadDir,
    read: (path) => deps.fs.read(path as AbsPath),
  });
}

/**
 * A wrap change means a new tree was deployed: a guard daemon from the
 * previous tree would keep patrolling with old code. SIGTERM it here;
 * install.sh starts a fresh daemon from the new tree right after, and
 * `openbot guard --daemon` does the same for CLI-direct installs.
 */
function stopStaleGuardForUpdate(deps: SupervisorDeps): void {
  const pid = deps.procs.readPidFile(deps.paths.guardPid);
  if (pid === undefined || !deps.procs.pidAlive(pid)) {
    deps.fs.remove(deps.paths.guardPid);
    return;
  }
  deps.procs.stop(parseOwnedPid(pid));
  try {
    if (deps.procs.readPidFile(deps.paths.guardPid) === pid) {
      deps.fs.remove(deps.paths.guardPid);
    }
  } catch {
    /* pidfile cleanup is best-effort */
  }
}

async function waitPort(deps: SupervisorDeps, port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await deps.procs.port(LOOPBACK, port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return deps.procs.port(LOOPBACK, port);
}

async function waitPortDown(deps: SupervisorDeps, port: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!(await deps.procs.port(LOOPBACK, port))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return !(await deps.procs.port(LOOPBACK, port));
}

function startService(deps: SupervisorDeps): void {
  deps.fs.mkdirp(deps.paths.sandData);
  deps.procs.start({
    argv: ["--experimental-strip-types", deps.paths.uiServer],
    env: { ...process.env, ...sharedEnv(deps) },
    log: deps.paths.uiLog,
    pidFile: deps.paths.uiPid,
  });
}

async function ensureService(
  deps: SupervisorDeps,
  beforeKind: "ours" | "absent" | "foreign",
  opts: ReconcileOpts,
): Promise<ReconcileResult | undefined> {
  if (beforeKind === "ours" && opts.reloadService) {
    const uiPid = deps.procs.readPidFile(deps.paths.uiPid);
    if (uiPid !== undefined && deps.procs.pidAlive(uiPid)) {
      deps.procs.stop(parseOwnedPid(uiPid));
      deps.fs.remove(deps.paths.uiPid);
    }
    if (!(await waitPortDown(deps, SERVICE_PORT, 4000))) {
      return { kind: "refused", error: { kind: "listen-failed", port: SERVICE_PORT } };
    }
    startService(deps);
    if (!(await waitPort(deps, SERVICE_PORT, 4000))) {
      return { kind: "refused", error: { kind: "listen-failed", port: SERVICE_PORT } };
    }
    return undefined;
  }
  if (beforeKind === "absent") {
    startService(deps);
    if (!(await waitPort(deps, SERVICE_PORT, 4000))) {
      return { kind: "refused", error: { kind: "listen-failed", port: SERVICE_PORT } };
    }
  }
  return undefined;
}

function stopLeftoverHopOnly(deps: SupervisorDeps): void {
  const hopPid = deps.procs.readPidFile(deps.paths.hopPid);
  const uiPid = deps.procs.readPidFile(deps.paths.uiPid);
  if (hopPid === undefined || hopPid === uiPid) {
    return;
  }
  if (!deps.procs.pidAlive(hopPid)) {
    deps.fs.remove(deps.paths.hopPid);
    return;
  }
  deps.procs.stop(parseOwnedPid(hopPid));
  deps.fs.remove(deps.paths.hopPid);
}

async function stopStaleService(deps: SupervisorDeps): Promise<void> {
  const uiPid = deps.procs.readPidFile(deps.paths.uiPid);
  if (uiPid === undefined || !deps.procs.pidAlive(uiPid)) {
    return;
  }
  if (await deps.procs.port(LOOPBACK, SERVICE_PORT)) {
    return;
  }
  deps.procs.stop(parseOwnedPid(uiPid));
  deps.fs.remove(deps.paths.uiPid);
}


function loggingEnabledFromDisk(deps: SupervisorDeps): boolean {
  const raw = deps.fs.read(deps.paths.logsSettings);
  if (raw === undefined) {
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as { loggingEnabled?: unknown };
    return parsed.loggingEnabled === true;
  } catch {
    return false;
  }
}

function sourceForMarkedWrap(source: string): string {
  if (
    source.includes("attachSession(createProtoSessionProvider_stock") ||
    source.includes("wrapSession(createProtoSessionProvider_stock")
  ) {
    return source;
  }
  if (source.includes(OPENBOT_MARKER)) {
    return stripWrap(source);
  }
  return source;
}

function restoreOfficialHost(deps: SupervisorDeps, source: string, opts: ReconcileOpts): boolean {
  const peeled = peelOpengrokToStock(source);
  if (peeled.kind === "stock" && peeled.source !== source) {
    deps.fs.write(deps.paths.hostMain, peeled.source, 0o644);
    appendAudit(deps, opts, "wrap", wrapFromSource(source).kind, wrapFromSource(peeled.source).kind);
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
  appendAudit(deps, opts, "wrap", wrapFromSource(source).kind, wrapFromSource(restored).kind);
  return true;
}

function installCustomWrap(
  deps: SupervisorDeps,
  source: string,
  opts: ReconcileOpts,
  fingerprint: string,
): ReconcileResult | { changed: boolean } {
  if (source.includes(OPENBOT_MARKER)) {
    // Already wrapped, but the wrap header is byte-stable across payload
    // deploys: refresh the payload stamp so a payload change rewrites the
    // host file and bounces the stale host below.
    const before = extractPayloadFingerprint(source) ?? "none";
    const refreshed = refreshPayloadStamp(source, fingerprint);
    if (!refreshed.changed) {
      return { changed: false };
    }
    deps.fs.write(deps.paths.hostMain, refreshed.source, 0o644);
    appendAudit(deps, opts, "wrap", `payload:${before}`, `payload:${fingerprint}`);
    return { changed: true };
  }
  const proof = wrapHostSource({ source, runtimePath: deps.paths.runtime, payloadFingerprint: fingerprint });
  if (proof.kind === "refused") {
    return { kind: "refused", error: { kind: "census-refused", reason: proof.reason } };
  }
  if (proof.kind === "already-marked") {
    return { changed: false };
  }
  deps.fs.mkdirp(deps.paths.sandData);
  const backupBefore = fileState(deps, deps.paths.knownBackup);
  deps.fs.write(deps.paths.knownBackup, source, 0o644);
  appendAudit(deps, opts, "backup", backupBefore, "present");
  // Node treats the last suffix as the module type. A name ending in
  // .openbot-check makes `node --check` fail on current Node.
  const tmp = writeTemp(deps.fs, deps.paths.sandData, "host-main.openbot-check.cjs", proof.source);
  const check = deps.procs.syntaxCheck(tmp);
  deps.fs.remove(tmp);
  if (!check.ok) {
    return { kind: "refused", error: { kind: "syntax-check-failed", stderr: check.stderr } };
  }
  deps.fs.write(deps.paths.hostMain, proof.source, 0o644);
  appendAudit(deps, opts, "wrap", wrapFromSource(source).kind, wrapFromSource(proof.source).kind);
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

async function finishOk(
  deps: SupervisorDeps,
  desired: DesiredState,
  wrapBytesChanged: boolean,
): Promise<ReconcileResult> {
  // Official must never leave the custom guard patrol running: with a
  // non-empty catalog on disk the guard treats official mode as drift and
  // reconciles back to custom on the next tick. install.sh only starts the
  // daemon for custom installs, so stopping it here keeps official stable.
  // Custom keeps the previous conditional: only a new tree (wrap change)
  // orphans the daemon from the previous tree.
  if (desired.kind === "official" || wrapBytesChanged) {
    stopStaleGuardForUpdate(deps);
  }
  await bounceHostIfNeeded(deps, wrapBytesChanged);
  const tunnel = await reconcileExpose(desired.expose, deps);
  const snapshot = await observe(deps);
  return {
    kind: "ok",
    snapshot: { ...snapshot, tunnel },
    wrapBytesChanged,
  };
}

export async function reconcile(
  desired: DesiredState,
  deps: SupervisorDeps,
  opts: ReconcileOpts = {},
): Promise<ReconcileResult> {
  const raw = deps.fs.read(deps.paths.hostMain);
  if (raw === undefined) {
    return { kind: "refused", error: { kind: "host-missing", path: deps.paths.hostMain } };
  }

  const peeled = peelOpengrokToStock(raw);
  if (wrapFromSource(raw).kind === "foreign-opengrok" && peeled.kind === "still-foreign") {
    return { kind: "refused", error: { kind: "foreign-opengrok" } };
  }
  const source = peeled.kind === "stock" ? peeled.source : raw;

  for (const pid of deps.procs.opengrokHopPids()) {
    deps.procs.stop(pid);
  }
  stopLeftoverHopOnly(deps);
  await stopStaleService(deps);

  const before = await observe(deps);
  if (before.uiListen.kind === "foreign") {
    return { kind: "refused", error: { kind: desired.kind === "custom" ? "foreign-hop" : "foreign-ui" } };
  }

  deps.fs.mkdirp(deps.paths.sandData);
  let wrapBytesChanged = false;

  // Payload fingerprint: a payload deploy must bounce the host even though
  // the wrap header itself would otherwise be byte-identical.
  const payloadFp = currentPayloadFingerprint(deps);

  if (desired.kind === "official") {
    writeMode(deps, "official", opts);
    if (loggingEnabledFromDisk(deps)) {
      const toWrap = sourceForMarkedWrap(source);
      const census = censusHost(toWrap);
      if (census.kind === "private-lane" || census.kind === "gap" || census.kind === "ambiguous-factory") {
        return {
          kind: "refused",
          error: { kind: "census-refused", reason: `cannot wrap a ${census.kind} host` },
        };
      }
      const wrapped = installCustomWrap(deps, toWrap, opts, payloadFp);
      if ("kind" in wrapped) {
        return wrapped;
      }
      wrapBytesChanged = wrapped.changed || raw !== toWrap;
    } else {
      wrapBytesChanged = restoreOfficialHost(deps, raw, opts);
    }
    const service = await ensureService(deps, before.uiListen.kind, opts);
    if (service) {
      return service;
    }
    return finishOk(deps, desired, wrapBytesChanged);
  }

  const census = censusHost(source);
  if (census.kind === "private-lane" || census.kind === "gap" || census.kind === "ambiguous-factory") {
    return {
      kind: "refused",
      error: { kind: "census-refused", reason: `cannot wrap a ${census.kind} host` },
    };
  }

  const wrapped = installCustomWrap(deps, source, opts, payloadFp);
  if ("kind" in wrapped) {
    return wrapped;
  }
  wrapBytesChanged = wrapped.changed || raw !== source;
  writeMode(deps, "custom", opts);
  const planBefore = fileState(deps, deps.paths.plan);
  deps.fs.write(deps.paths.plan, planToJson(compileCustomPlan(desired)), 0o644);
  appendAudit(deps, opts, "plan", planBefore, "present");

  const service = await ensureService(deps, before.uiListen.kind, opts);
  if (service) {
    return service;
  }
  return finishOk(deps, desired, wrapBytesChanged);
}
