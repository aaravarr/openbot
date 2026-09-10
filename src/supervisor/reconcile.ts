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
  | {
      readonly kind: "ok";
      readonly snapshot: Snapshot;
      readonly wrapBytesChanged: boolean;
      /** What happened to the stale host: bounced now, armed for later, or not needed. */
      readonly hostBounce: HostBounce;
    }
  | { readonly kind: "refused"; readonly error: ReconcileError };

export type ReconcileOpts = {
  /** CLI install copies a new tree. Restart the owned loopback process so it loads that tree. */
  readonly reloadService?: boolean;
  /** Who asked for this reconcile; recorded on every audit line. */
  readonly source?: string;
  /**
   * Never SIGTERM the host inside this call. The caller is a bot turn running
   * inside host-main.cjs, so an immediate bounce kills the turn that started
   * the upgrade. A wrap change is written to disk as usual and a pending
   * marker is armed instead; `finalize-host` applies it once the host is idle.
   */
  readonly deferHostBounce?: boolean;
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

/** Outcome of the host-bounce half of a reconcile. */
export type HostBounce = "none" | "done" | "deferred";

/**
 * Quiet windows for the deferred bounce, measured from the last hop activity.
 * `stop` is a model that finished its answer, so the turn is almost certainly
 * over; anything else (tool_calls, no answer yet) may still have a shell tool
 * running and waits much longer.
 */
export const DEFERRED_BOUNCE_STOP_QUIET_MS = 90_000;
export const DEFERRED_BOUNCE_BUSY_QUIET_MS = 300_000;
/**
 * Nothing may be applied while the marker is younger than this, however
 * healthy the lease looks. The install that arms the marker is writing its
 * result and the first guard tick runs right after the service restart, so a
 * freshly armed marker is never "idle" no matter what the lease says.
 */
export const DEFERRED_BOUNCE_GRACE_MS = 120_000;
/** Hard upper bound on how long an armed bounce may stay pending. */
export const DEFERRED_BOUNCE_MAX_WAIT_MS = 600_000;
/** An `active` count quieter than this is a leak (killed hop, dropped client). */
export const DEFERRED_BOUNCE_STALE_ACTIVE_MS = 900_000;
/**
 * Floor for the CLI wait flags. Below this a `finalize-host` invocation could
 * delete the protection it exists to provide (grace, idle window), so the
 * flags refuse the value instead of clamping it silently.
 */
export const DEFERRED_BOUNCE_MIN_WAIT_MS = 1_000;

/** Marker written when a payload upgrade defers the host bounce. */
export type PendingHostBounce = {
  readonly armedAt: string;
  readonly armedAtMs: number;
  /** Payload fingerprint the host file was rewritten with. */
  readonly fingerprint: string;
  /** Host pids seen when the bounce was armed (informational; re-checked on apply). */
  readonly hostPids: readonly number[];
  readonly source: string;
};

/** Idle oracle written by the hop process on every request boundary. */
export type TurnLease = {
  readonly active: number;
  readonly lastStartAt: number;
  readonly lastEndAt: number;
  readonly lastFinishReason: string | undefined;
  /** Latest of start/end/updated: the quiet window is measured from here. */
  readonly updatedAt: number;
};

export type DeferredBounceTuning = {
  /** Injected clock for tests. */
  readonly nowMs?: number;
  readonly stopQuietMs?: number;
  readonly busyQuietMs?: number;
  readonly maxWaitMs?: number;
  readonly graceMs?: number;
  readonly staleActiveMs?: number;
  /** Skip the quiet gate. Never skips the grace window or an in-flight request. */
  readonly force?: boolean;
};

/** Why an armed bounce was left alone; every one of these is a no-kill path. */
export type DeferredBounceHoldReason =
  | "grace"
  | "no-lease"
  | "turn-active"
  | "quiet-window"
  /** The marker changed under us between two reads: a concurrent arm, not corruption. */
  | "marker-changing";

export type DeferredBounceOutcome =
  | { readonly kind: "applied"; readonly pids: readonly number[]; readonly forced: boolean }
  | { readonly kind: "idle-pending"; readonly reason: DeferredBounceHoldReason }
  | {
      readonly kind: "skipped";
      readonly reason: "no-marker" | "corrupt-marker" | "stamp-changed" | "host-absent" | "already-restarted";
    };

function numberOrZero(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

/** True when a pending marker exists on disk (even a corrupt one). */
export function pendingHostBounce(deps: SupervisorDeps): boolean {
  return deps.fs.read(deps.paths.pendingBounce) !== undefined;
}

function parsePendingBounce(raw: string): PendingHostBounce | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fingerprint = parsed.fingerprint;
    if (typeof fingerprint !== "string" || fingerprint === "") {
      return undefined;
    }
    const parsedAt = typeof parsed.armedAt === "string" ? Date.parse(parsed.armedAt) : Number.NaN;
    const armedAtMs = Number.isFinite(numberOrZero(parsed.armedAtMs))
      ? numberOrZero(parsed.armedAtMs) || parsedAt
      : parsedAt;
    if (!Number.isFinite(armedAtMs)) {
      return undefined;
    }
    const hostPids = Array.isArray(parsed.hostPids)
      ? parsed.hostPids.filter((pid): pid is number => Number.isInteger(pid))
      : [];
    return {
      armedAt: new Date(armedAtMs).toISOString(),
      armedAtMs,
      fingerprint,
      hostPids,
      source: typeof parsed.source === "string" ? parsed.source : "unknown",
    };
  } catch {
    return undefined;
  }
}

export function readPendingBounce(deps: SupervisorDeps): PendingHostBounce | undefined {
  const raw = deps.fs.read(deps.paths.pendingBounce);
  return raw === undefined ? undefined : parsePendingBounce(raw);
}

/** Corrupt lease = no lease: the caller falls back to the conservative window. */
export function readTurnLease(deps: SupervisorDeps): TurnLease | undefined {
  const raw = deps.fs.read(deps.paths.turnLease);
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      // Valid JSON that is not a lease object is still "no lease".
      return undefined;
    }
    const row = parsed as Record<string, unknown>;
    const lastStartAt = numberOrZero(row.lastStartAt);
    const lastEndAt = numberOrZero(row.lastEndAt);
    return {
      active: Math.max(0, Math.trunc(numberOrZero(row.active))),
      lastStartAt,
      lastEndAt,
      lastFinishReason: typeof row.lastFinishReason === "string" ? row.lastFinishReason : undefined,
      updatedAt: Math.max(numberOrZero(row.updatedAt), lastStartAt, lastEndAt),
    };
  } catch {
    return undefined;
  }
}

/**
 * The upgrade must not end the caller's turn: SIGTERM the host only when no
 * hop request is in flight and the last one has been quiet long enough. With
 * no lease at all (official mode never hops) the marker's own age is the only
 * evidence, so the conservative window applies.
 */
export function deferredBounceIdle(input: {
  readonly lease: TurnLease | undefined;
  readonly nowMs: number;
  readonly armedAtMs: number;
  readonly stopQuietMs?: number;
  readonly busyQuietMs?: number;
  readonly graceMs?: number;
  readonly staleActiveMs?: number;
}): boolean {
  return deferredBounceHold(input) === undefined;
}

/**
 * Why (or whether) the bounce must wait. `undefined` means "apply now".
 *
 * Order matters and each gate is a hard stop:
 * 1. grace: the marker itself must be old enough — the first guard tick after
 *    the install that armed it must never apply.
 * 2. an in-flight hop request, unless the lease is so old that it is a leak.
 * 3. a lease must exist at all. The box that upgrades from a release without
 *    lease support has no file until its new UI starts, and "no evidence of
 *    idleness" is not evidence of idleness.
 * 4. the quiet window, measured from max(last activity, armed at), so a quiet
 *    lease from before the marker was armed cannot shorten the wait.
 *
 * `stop` (a model that finished its answer) is the only reason that uses the
 * short window; a tool call still running keeps the long one.
 */
export function deferredBounceHold(input: {
  readonly lease: TurnLease | undefined;
  readonly nowMs: number;
  readonly armedAtMs: number;
  readonly stopQuietMs?: number;
  readonly busyQuietMs?: number;
  readonly graceMs?: number;
  readonly staleActiveMs?: number;
}): DeferredBounceHoldReason | undefined {
  const graceMs = input.graceMs ?? DEFERRED_BOUNCE_GRACE_MS;
  if (!(input.nowMs - input.armedAtMs >= graceMs)) {
    return "grace";
  }
  const lease = input.lease;
  const busyQuietMs0 = input.busyQuietMs ?? DEFERRED_BOUNCE_BUSY_QUIET_MS;
  if (lease === undefined) {
    // No lease at all means "no evidence of an idle host", never "idle": the
    // quiet window is measured from the marker instead, so the bounce stays
    // deferred but cannot be stranded forever on a box whose lease was never
    // written (a UI that failed to restart, a hand-edited sand-data dir).
    return input.nowMs - input.armedAtMs >= busyQuietMs0 ? undefined : "no-lease";
  }
  const staleActiveMs = input.staleActiveMs ?? DEFERRED_BOUNCE_STALE_ACTIVE_MS;
  if (lease.active > 0 && input.nowMs - Math.max(lease.lastStartAt, lease.updatedAt) < staleActiveMs) {
    return "turn-active";
  }
  const busyQuietMs = input.busyQuietMs ?? DEFERRED_BOUNCE_BUSY_QUIET_MS;
  const quietMs = lease.lastFinishReason === "stop" ? input.stopQuietMs ?? DEFERRED_BOUNCE_STOP_QUIET_MS : busyQuietMs;
  // The clock starts at the later of the last hop activity and the marker:
  // a lease file that predates the upgrade never shortens the wait.
  if (input.nowMs - Math.max(lease.updatedAt, input.armedAtMs) < quietMs) {
    return "quiet-window";
  }
  return undefined;
}

/**
 * Record that the host file changed but the running host must not be killed
 * yet. Re-arming keeps the first `armedAt` so `maxWaitMs` stays a real bound
 * across repeated installs; the fingerprint and targets are refreshed.
 */
export function armDeferredHostBounce(
  deps: SupervisorDeps,
  opts: ReconcileOpts,
  fingerprint: string,
): PendingHostBounce {
  const existing = readPendingBounce(deps);
  const nowMs = Date.now();
  // armedAt only ever moves forward: refreshing it on every re-arm would reset
  // the max-wait bound, so an install loop would never converge. The grace and
  // quiet windows then also measure from the oldest arm, which is the
  // conservative direction (later bounce).
  const armedAtMs = Math.min(existing?.armedAtMs ?? nowMs, nowMs);
  const marker: PendingHostBounce = {
    armedAt: new Date(armedAtMs).toISOString(),
    armedAtMs,
    fingerprint,
    hostPids: deps.procs.hostPids(deps.paths.hostMain),
    source: opts.source ?? "unknown",
  };
  writePendingBounce(deps, `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

/**
 * Write the marker atomically: temp file, then rename over the target.
 *
 * A finalizer polls every few seconds, so a plain overwrite gives it a window
 * where it reads a half-written file. That read parses as corrupt, and the
 * corrupt path retires the marker — after which no reconcile ever sees a wrap
 * change again and the host is stranded on the previous payload forever. The
 * rename makes the target flip between two complete versions instead.
 *
 * Test doubles without `rename` keep the legacy direct write; the real
 * `nodeFs` always provides it.
 */
function writePendingBounce(deps: SupervisorDeps, body: string): void {
  const rename = deps.fs.rename;
  if (rename === undefined) {
    deps.fs.write(deps.paths.pendingBounce, body, 0o644);
    return;
  }
  const tmp = joinAbs(deps.paths.sandData, `openbot-pending-bounce.json.${String(process.pid)}.tmp`);
  deps.fs.write(tmp, body, 0o644);
  try {
    rename.call(deps.fs, tmp, deps.paths.pendingBounce);
  } catch (err) {
    // Never leave a stray temp file behind for the next install to trip over.
    try {
      deps.fs.remove(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Compare-and-clear: only drop the marker we actually read. A concurrent
 * finalizer that already replaced or consumed it keeps its own copy.
 */
function clearPendingBounce(deps: SupervisorDeps, seen: string | undefined): void {
  if (seen !== undefined && deps.fs.read(deps.paths.pendingBounce) !== seen) {
    return;
  }
  deps.fs.remove(deps.paths.pendingBounce);
}

/** A live finalizer owns the marker; the guard tick leaves it alone. */
export function finalizeHostRunning(deps: SupervisorDeps): boolean {
  const pid = deps.procs.readPidFile(deps.paths.finalizePid);
  return pid !== undefined && deps.procs.pidAlive(pid);
}

/** Start time of a recorded pid, when the platform can report it. */
function pidStartMs(deps: SupervisorDeps, pid: number): number | undefined {
  return deps.procs.pidStartMs?.(parseOwnedPid(pid));
}

/**
 * A host process that started after the marker was armed is already running
 * the new payload (the box rebooted, or the supervisor relaunched the host).
 * Killing it would bounce a healthy host for nothing, so the marker is retired
 * instead. Undefined start time means "cannot tell" and the argv check rules.
 */
function pidPredatesMarker(deps: SupervisorDeps, pid: number, armedAtMs: number): boolean {
  const start = pidStartMs(deps, pid);
  return start === undefined || start <= armedAtMs + 5_000;
}

function pidStillTheHost(deps: SupervisorDeps, pid: number): boolean {
  const owned = parseOwnedPid(pid);
  if (deps.procs.hostPidMatches !== undefined) {
    return deps.procs.hostPidMatches(owned, deps.paths.hostMain);
  }
  // Without a direct argv probe the enumeration itself is the argv check.
  return deps.procs.hostPids(deps.paths.hostMain).includes(owned);
}

/**
 * Apply an armed deferred bounce when the host is idle, then clear the marker.
 * Idempotent: the marker is the single source of truth, so a second call (or a
 * second finalizer) is a no-op. The stamp is re-checked first, so a later
 * reconcile that already rewrote the wrap (mode switch, another payload)
 * abandons the stale marker instead of bouncing a host it no longer knows.
 */
export function applyDeferredHostBounce(
  deps: SupervisorDeps,
  opts: ReconcileOpts = {},
  tuning: DeferredBounceTuning = {},
): DeferredBounceOutcome {
  const raw = deps.fs.read(deps.paths.pendingBounce);
  if (raw === undefined) {
    return { kind: "skipped", reason: "no-marker" };
  }
  // An unreadable marker is retired loudly instead of being re-read forever:
  // a silent exit here is what leaves a stale host running with a new payload.
  // Retiring it is only safe once the bytes are known to be stable, though: a
  // marker that changes between two reads is a concurrent arm (or a writer
  // that is not us), and deleting it there is exactly how a box gets stranded
  // on the previous payload.
  const marker = parsePendingBounce(raw);
  if (marker === undefined) {
    if (deps.fs.read(deps.paths.pendingBounce) !== raw) {
      return { kind: "idle-pending", reason: "marker-changing" };
    }
    clearPendingBounce(deps, raw);
    appendAudit(deps, opts, "wrap", "bounce:deferred", "bounce:corrupt");
    return { kind: "skipped", reason: "corrupt-marker" };
  }
  if (marker.fingerprint !== currentPayloadFingerprint(deps)) {
    clearPendingBounce(deps, raw);
    appendAudit(deps, opts, "wrap", "bounce:deferred", "bounce:stale");
    return { kind: "skipped", reason: "stamp-changed" };
  }
  const nowMs = tuning.nowMs ?? Date.now();
  const lease = readTurnLease(deps);
  const maxWaitMs = tuning.maxWaitMs ?? DEFERRED_BOUNCE_MAX_WAIT_MS;
  // Max wait forces past the quiet window only. It never skips the grace
  // window and never kills a request that is in flight: a mid-turn SIGTERM is
  // the exact failure this marker exists to avoid, and the upstream timeout
  // bounds how long one request can sit in the lease.
  const forced = tuning.force === true || nowMs - marker.armedAtMs >= maxWaitMs;
  const hold = deferredBounceHold({
    lease,
    nowMs,
    armedAtMs: marker.armedAtMs,
    ...(tuning.stopQuietMs !== undefined ? { stopQuietMs: tuning.stopQuietMs } : {}),
    ...(tuning.busyQuietMs !== undefined ? { busyQuietMs: tuning.busyQuietMs } : {}),
    ...(tuning.graceMs !== undefined ? { graceMs: tuning.graceMs } : {}),
    ...(tuning.staleActiveMs !== undefined ? { staleActiveMs: tuning.staleActiveMs } : {}),
  });
  // Forcing past the wait is allowed to expire the quiet window and the
  // no-lease fallback. It is never allowed to skip the grace period or to end
  // a request that is still in flight (X4): those two are the failure modes
  // this whole marker exists to prevent.
  if (hold !== undefined && !(forced && (hold === "quiet-window" || hold === "no-lease"))) {
    return { kind: "idle-pending", reason: hold };
  }
  // Targets come from the marker only. Re-enumerating host pids would kill the
  // replacement the supervisor starts right after the first SIGTERM, once per
  // tick; a marker that no longer names a live host is retired instead.
  // Re-proving argv keeps a recycled pid from being signalled.
  const targets = marker.hostPids.filter(
    (pid) => pidPredatesMarker(deps, pid, marker.armedAtMs) && pidStillTheHost(deps, pid),
  );
  if (targets.length === 0) {
    const restarted = marker.hostPids.some((pid) => !pidPredatesMarker(deps, pid, marker.armedAtMs));
    clearPendingBounce(deps, raw);
    appendAudit(deps, opts, "wrap", "bounce:deferred", restarted ? "bounce:already-restarted" : "bounce:absent");
    return { kind: "skipped", reason: restarted ? "already-restarted" : "host-absent" };
  }
  for (const pid of targets) {
    try {
      deps.procs.term(parseOwnedPid(pid));
    } catch {
      /* raced with a relaunch or an earlier term: already gone */
    }
  }
  clearPendingBounce(deps, raw);
  appendAudit(deps, opts, "wrap", forced ? "bounce:deferred+max-wait" : "bounce:deferred", "bounce:done");
  return { kind: "applied", pids: targets, forced };
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

/**
 * A refused ensureService returns before finishOk, after the host file has
 * already been rewritten. Without the marker the next reconcile sees no wrap
 * change and the stale host runs forever on the old payload, so the arm
 * happens here too. Only the deferred path changes: the immediate path keeps
 * its long-standing "no bounce on refusal" behaviour.
 */
function refusalKeepingTheWrapChange(
  deps: SupervisorDeps,
  opts: ReconcileOpts,
  wrapBytesChanged: boolean,
  payloadFp: string,
  refusal: ReconcileResult,
): ReconcileResult {
  if (wrapBytesChanged && (opts.deferHostBounce === true || pendingHostBounce(deps))) {
    armDeferredHostBounce(deps, opts, payloadFp);
  }
  return refusal;
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
  opts: ReconcileOpts,
  payloadFp: string,
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
  // A wrap change normally bounces the stale host here. A bot self-upgrade
  // passes deferHostBounce: the caller is a bot turn living inside that very
  // host, so the file is rewritten and a pending marker is armed instead; the
  // detached finalizer (or the guard tick) applies the SIGTERM once idle.
  let hostBounce: HostBounce = "none";
  if (wrapBytesChanged) {
    // An armed marker means a bounce is already scheduled for later. Every
    // other reconcile caller (guard repair, UI save, tunnel on/off) must not
    // jump the queue and SIGTERM a host that may be mid-turn: the pending
    // bounce is refreshed instead and applied once idle.
    if (opts.deferHostBounce === true || pendingHostBounce(deps)) {
      armDeferredHostBounce(deps, opts, payloadFp);
      hostBounce = "deferred";
    } else {
      await bounceHostIfNeeded(deps, true);
      hostBounce = "done";
    }
  }
  const tunnel = await reconcileExpose(desired.expose, deps);
  const snapshot = await observe(deps);
  return {
    kind: "ok",
    snapshot: { ...snapshot, tunnel },
    wrapBytesChanged,
    hostBounce,
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
  // Older layouts could leave the unified-port hop alive without its pidfile.
  // Identify only the known OpenBot hop entrypoint, then clear it before the
  // UI service is classified or restarted; otherwise the hop wins 9280 and
  // every UI route returns its 404 fallback.
  for (const pid of deps.procs.hopServerPids?.(deps.paths.hopServer) ?? []) {
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
      return refusalKeepingTheWrapChange(deps, opts, wrapBytesChanged, payloadFp, service);
    }
    return finishOk(deps, desired, wrapBytesChanged, opts, payloadFp);
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
    return refusalKeepingTheWrapChange(deps, opts, wrapBytesChanged, payloadFp, service);
  }
  return finishOk(deps, desired, wrapBytesChanged, opts, payloadFp);
}
