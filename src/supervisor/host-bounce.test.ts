import assert from "node:assert/strict";
import test from "node:test";
import { OPENBOT_MARKER } from "../domain/types.ts";
import { wrapHostSource } from "../host/wrap.ts";
import { customBoxFromProvider, officialBox, parseUpstreamOrigin } from "../parse/argv.ts";
import { boxPathsFrom, joinAbs } from "./paths.ts";
import { type FsDeps, type ProcDeps, parseOwnedPid } from "./procs.ts";
import {
  DEFERRED_BOUNCE_BUSY_QUIET_MS,
  DEFERRED_BOUNCE_GRACE_MS,
  DEFERRED_BOUNCE_MAX_WAIT_MS,
  DEFERRED_BOUNCE_STOP_QUIET_MS,
  applyDeferredHostBounce,
  pendingHostBounce,
  readPendingBounce,
  reconcile,
  type ReconcileOpts,
} from "./reconcile.ts";

const STOCK = `function createProtoSessionProvider(client) {
  return { getSession: function () { return 1; } };
}
`;

const ORIGIN = parseUpstreamOrigin("https://open.bigmodel.cn/api/paas/v4");
const NOW = 1_700_000_000_000;

type FakeProcs = ProcDeps & {
  termed: number[];
  stopped: number[];
  hostPidList: number[];
  matches: Map<number, boolean>;
  starts: Map<number, number>;
  termThrows: boolean;
  /** Port 9280 answers even though no service was started by this fake. */
  portUp: boolean;
};

type MemoryFs = FsDeps & {
  files: Record<string, string>;
  renames: { from: string; to: string }[];
  /**
   * Scripted reads: after `skip` reads of a path, the next one returns
   * `value` instead of the file. Used to simulate a writer replacing the file
   * between two reads.
   */
  scriptedRead: Map<string, { skip: number; value: string | undefined }>;
  readCounts: Map<string, number>;
};

function memoryFs(init: Record<string, string>): MemoryFs {
  const files: Record<string, string> = { ...init };
  const renames: { from: string; to: string }[] = [];
  const scriptedRead = new Map<string, { skip: number; value: string | undefined }>();
  const readCounts = new Map<string, number>();
  return {
    files,
    renames,
    scriptedRead,
    readCounts,
    read(path) {
      const seen = readCounts.get(path) ?? 0;
      readCounts.set(path, seen + 1);
      const scripted = scriptedRead.get(path);
      if (scripted !== undefined && seen >= scripted.skip) {
        scriptedRead.delete(path);
        return scripted.value;
      }
      return Object.prototype.hasOwnProperty.call(files, path) ? files[path] : undefined;
    },
    write(path, body) {
      files[path] = body;
    },
    copy(from, to) {
      const src = files[from];
      if (src !== undefined) files[to] = src;
    },
    remove(path) {
      delete files[path];
    },
    exists(path) {
      return Object.prototype.hasOwnProperty.call(files, path);
    },
    mkdirp() {},
    rename(from, to) {
      renames.push({ from, to });
      const src = files[from];
      if (src === undefined) {
        throw new Error(`rename: missing ${from}`);
      }
      files[to] = src;
      delete files[from];
    },
  };
}

function fakeProcs(hostPids: number[]): FakeProcs {
  const termed: number[] = [];
  const stopped: number[] = [];
  const matches = new Map<number, boolean>();
  const starts = new Map<number, number>();
  let up = false;
  const procs: FakeProcs = {
    termed,
    stopped,
    hostPidList: hostPids,
    matches,
    starts,
    termThrows: false,
    portUp: false,
    async port() {
      return up || procs.portUp;
    },
    readPidFile() {
      return undefined;
    },
    pidAlive() {
      return false;
    },
    start() {
      up = true;
      return parseOwnedPid(43);
    },
    stop(pid) {
      stopped.push(pid);
    },
    hostPids() {
      return hostPids.map((pid) => parseOwnedPid(pid));
    },
    hostPidMatches(pid) {
      return matches.get(pid) ?? true;
    },
    pidStartMs(pid) {
      return starts.get(pid);
    },
    opengrokHopPids() {
      return [];
    },
    term(pid) {
      if (procs.termThrows) {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }
      termed.push(pid);
    },
    syntaxCheck() {
      return { ok: true };
    },
  };
  return procs;
}

/** A legacy-marked host (no payload stamp) so a reconcile always sees a wrap change. */
function legacyWrapped(): string {
  const proof = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(proof.kind, "wrapped");
  if (proof.kind !== "wrapped") throw new Error("wrap failed in fixture");
  return proof.source;
}

function setup(hostPids: number[] = [99]) {
  const paths = boxPathsFrom({
    repoRoot: "/tmp/openbot-bounce-repo",
    sandData: "/tmp/openbot-bounce-data",
    hostMain: "/tmp/openbot-bounce-host/host-main.cjs",
  });
  const fs = memoryFs({ [paths.hostMain]: legacyWrapped() });
  const procs = fakeProcs(hostPids);
  return { deps: { paths, fs, procs }, fs, procs, paths };
}

type Ctx = ReturnType<typeof setup>;

function zhipu(paths: Ctx["paths"]) {
  return customBoxFromProvider({ paths, origin: ORIGIN, name: "Zhipu", modelSlug: "glm-5.3-flash" });
}

function auditRows(ctx: Ctx): { action: string; from: string; to: string }[] {
  const raw = ctx.fs.read(joinAbs(ctx.paths.sandData, "openbot-audit.jsonl")) ?? "";
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { action: string; from: string; to: string });
}

/** Write a lease as the hop would. Omitted timestamps mean "just now". */
function writeLease(
  ctx: Ctx,
  lease: { active: number; updatedAt: number; finishReason?: string | undefined; lastStartAt?: number },
): void {
  ctx.fs.write(
    ctx.paths.turnLease,
    `${JSON.stringify({
      active: lease.active,
      lastStartAt: lease.lastStartAt ?? lease.updatedAt,
      lastEndAt: lease.updatedAt,
      lastFinishReason: lease.finishReason,
      updatedAt: lease.updatedAt,
    })}\n`,
  );
}

/** Re-arm an existing marker with an older armedAt, as if time had passed. */
function ageMarker(ctx: Ctx, ageMs: number): void {
  const marker = readPendingBounce(ctx.deps);
  assert.ok(marker, "marker must exist before aging it");
  if (!marker) return;
  ctx.fs.write(
    ctx.paths.pendingBounce,
    `${JSON.stringify({ ...marker, armedAtMs: marker.armedAtMs - ageMs }, null, 2)}\n`,
  );
}

const DEFER: ReconcileOpts = { deferHostBounce: true };

// ---------------------------------------------------------------------------
// A. arming, and byte-for-byte default behaviour
// ---------------------------------------------------------------------------

test("A1: a deferred reconcile writes the marker and never terms the caller's host", async () => {
  const ctx = setup();
  const result = await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.wrapBytesChanged, true);
  assert.equal(result.hostBounce, "deferred");
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(pendingHostBounce(ctx.deps), true);
  const marker = readPendingBounce(ctx.deps);
  assert.ok(marker);
  assert.equal(typeof marker?.fingerprint, "string");
  assert.deepEqual(marker?.hostPids, [99]);
  assert.match(marker?.armedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  // The host file was still rewritten: only the SIGTERM is deferred.
  assert.equal(ctx.fs.read(ctx.paths.hostMain)?.includes(OPENBOT_MARKER), true);
});

test("A2: the default path still bounces immediately and writes no marker", async () => {
  const ctx = setup();
  const result = await reconcile(zhipu(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.hostBounce, "done");
  assert.deepEqual(ctx.procs.termed, [99]);
  assert.equal(pendingHostBounce(ctx.deps), false);
});

test("A3: the marker snapshots the host pids seen while arming", async () => {
  const ctx = setup([99]);
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ctx.procs.hostPidList.push(200);
  assert.deepEqual(readPendingBounce(ctx.deps)?.hostPids, [99]);
});

test("A4: re-arming keeps the first armedAt so max wait still converges", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  const first = readPendingBounce(ctx.deps);
  assert.ok(first);
  await new Promise((resolve) => setTimeout(resolve, 5));
  ctx.fs.write(ctx.paths.hostMain, legacyWrapped());
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  const second = readPendingBounce(ctx.deps);
  assert.ok(second);
  assert.equal(second?.armedAtMs, first?.armedAtMs);
});

test("A5: official restore also honours the defer flag", async () => {
  const ctx = setup();
  ctx.fs.write(ctx.paths.logsSettings, JSON.stringify({ loggingEnabled: true }));
  const result = await reconcile(officialBox(ctx.paths), ctx.deps, DEFER);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.hostBounce, "deferred");
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(pendingHostBounce(ctx.deps), true);
});

test("A6: a wrap change killed by a refused service is still armed", async () => {
  const ctx = setup();
  // Port 9280 already answers with a live pidfile, and it never comes down, so
  // ensureService refuses before finishOk ever runs.
  ctx.procs.portUp = true;
  ctx.fs.write(ctx.paths.uiPid, "43\n");
  ctx.procs.pidAlive = (pid: number) => pid === 43;
  ctx.deps.procs.readPidFile = (path) => (String(path).endsWith("openbot-ui.pid") ? 43 : undefined);
  const result = await reconcile(zhipu(ctx.paths), ctx.deps, { ...DEFER, reloadService: true });
  assert.equal(result.kind, "refused");
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(pendingHostBounce(ctx.deps), true);
});

test("A7: a refused service without the defer flag keeps the old behaviour", async () => {
  const ctx = setup();
  ctx.procs.portUp = true;
  ctx.fs.write(ctx.paths.uiPid, "43\n");
  ctx.deps.procs.readPidFile = (path) => (String(path).endsWith("openbot-ui.pid") ? 43 : undefined);
  ctx.procs.pidAlive = (pid: number) => pid === 43;
  const result = await reconcile(zhipu(ctx.paths), ctx.deps, { reloadService: true });
  assert.equal(result.kind, "refused");
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(pendingHostBounce(ctx.deps), false);
});

// ---------------------------------------------------------------------------
// B. idle gating
// ---------------------------------------------------------------------------

test("B1: an in-flight request is never interrupted, not even by force", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, DEFERRED_BOUNCE_MAX_WAIT_MS + 60_000);
  const now = Date.now();
  writeLease(ctx, { active: 1, updatedAt: now });
  const held = applyDeferredHostBounce(ctx.deps, {}, { nowMs: now, force: true });
  assert.equal(held.kind, "idle-pending");
  if (held.kind === "idle-pending") assert.equal(held.reason, "turn-active");
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(pendingHostBounce(ctx.deps), true);
});

test("B2: a tool-calls turn keeps the long quiet window", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, DEFERRED_BOUNCE_BUSY_QUIET_MS + 10_000);
  const now = Date.now();
  writeLease(ctx, { active: 0, updatedAt: now - 10_000, finishReason: "tool_calls" });
  assert.equal(applyDeferredHostBounce(ctx.deps, {}, { nowMs: now }).kind, "idle-pending");
  writeLease(ctx, { active: 0, updatedAt: now - (DEFERRED_BOUNCE_BUSY_QUIET_MS - 1000), finishReason: "tool_calls" });
  assert.equal(applyDeferredHostBounce(ctx.deps, {}, { nowMs: now }).kind, "idle-pending");
  writeLease(ctx, { active: 0, updatedAt: now - (DEFERRED_BOUNCE_BUSY_QUIET_MS + 1000), finishReason: "tool_calls" });
  const applied = applyDeferredHostBounce(ctx.deps, {}, { nowMs: now });
  assert.equal(applied.kind, "applied");
  assert.deepEqual(ctx.procs.termed, [99]);
});

test("B3: a finished answer uses the short quiet window", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, DEFERRED_BOUNCE_BUSY_QUIET_MS + 10_000);
  const now = Date.now();
  writeLease(ctx, { active: 0, updatedAt: now - (DEFERRED_BOUNCE_STOP_QUIET_MS - 1000), finishReason: "stop" });
  assert.equal(applyDeferredHostBounce(ctx.deps, {}, { nowMs: now }).kind, "idle-pending");
  writeLease(ctx, { active: 0, updatedAt: now - (DEFERRED_BOUNCE_STOP_QUIET_MS + 1000), finishReason: "stop" });
  assert.equal(applyDeferredHostBounce(ctx.deps, {}, { nowMs: now }).kind, "applied");
});

test("B4: with no lease file at all the marker clock rules, and the box still converges", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  const now = Date.now();
  // Freshly armed on a box whose UI predates lease support: never idle.
  const fresh = applyDeferredHostBounce(ctx.deps, {}, { nowMs: now });
  assert.equal(fresh.kind, "idle-pending");
  if (fresh.kind === "idle-pending") assert.equal(fresh.reason, "grace");
  const early = applyDeferredHostBounce(ctx.deps, {}, { nowMs: now + DEFERRED_BOUNCE_GRACE_MS + 1000 });
  assert.equal(early.kind, "idle-pending");
  if (early.kind === "idle-pending") assert.equal(early.reason, "no-lease");
  const late = applyDeferredHostBounce(ctx.deps, {}, { nowMs: now + DEFERRED_BOUNCE_BUSY_QUIET_MS + 1000 });
  assert.equal(late.kind, "applied");
  assert.deepEqual(ctx.procs.termed, [99]);
});

test("B5: a corrupt or empty lease is treated as no lease, never as idle", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, DEFERRED_BOUNCE_GRACE_MS + 1000);
  const now = Date.now();
  for (const body of ["{broken", "", "null", "[]"]) {
    ctx.fs.write(ctx.paths.turnLease, body);
    const held = applyDeferredHostBounce(ctx.deps, {}, { nowMs: now });
    assert.equal(held.kind, "idle-pending", `lease body ${JSON.stringify(body)} must not read as idle`);
    if (held.kind === "idle-pending") assert.equal(held.reason, "no-lease");
  }
  assert.deepEqual(ctx.procs.termed, []);
});

test("B6: a lease timestamp in the future is never idle", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, DEFERRED_BOUNCE_GRACE_MS + 1000);
  const now = Date.now();
  writeLease(ctx, { active: 0, updatedAt: now + 3_600_000, finishReason: "stop" });
  assert.equal(applyDeferredHostBounce(ctx.deps, {}, { nowMs: now }).kind, "idle-pending");
});

test("B7: a leaked active count expires and the bounce converges with an audit line", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, DEFERRED_BOUNCE_BUSY_QUIET_MS + 10_000);
  const now = Date.now();
  writeLease(ctx, { active: 1, updatedAt: now - 20 * 60_000, lastStartAt: now - 20 * 60_000, finishReason: "tool_calls" });
  const applied = applyDeferredHostBounce(ctx.deps, {}, { nowMs: now, staleActiveMs: 15 * 60_000 });
  assert.equal(applied.kind, "applied");
  const rows = auditRows(ctx).filter((row) => row.action === "wrap" && row.to === "bounce:done");
  assert.equal(rows.length, 1);
});

test("B8: the quiet clock starts at max(lease activity, armedAt)", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, 200_000);
  const now = Date.now();
  // The lease is an hour old, but it predates the marker. Using updatedAt alone
  // would call this idle; the clock must start at the marker instead.
  writeLease(ctx, { active: 0, updatedAt: now - 3_600_000 });
  const held = applyDeferredHostBounce(ctx.deps, {}, { nowMs: now });
  assert.equal(held.kind, "idle-pending");
  if (held.kind === "idle-pending") assert.equal(held.reason, "quiet-window");
  assert.deepEqual(ctx.procs.termed, []);
  // Control: once the marker itself is older than the window, the same lease applies.
  ageMarker(ctx, 200_000);
  assert.equal(applyDeferredHostBounce(ctx.deps, {}, { nowMs: now }).kind, "applied");
});

// ---------------------------------------------------------------------------
// C. pid / stamp / restart safety
// ---------------------------------------------------------------------------

test("C1: a recycled pid is never signalled and the marker is retired", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, DEFERRED_BOUNCE_BUSY_QUIET_MS + 1000);
  ctx.procs.matches.set(99, false);
  const outcome = applyDeferredHostBounce(ctx.deps, {}, { nowMs: Date.now() });
  assert.equal(outcome.kind, "skipped");
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(pendingHostBounce(ctx.deps), false);
  assert.equal(auditRows(ctx).some((row) => row.to === "bounce:absent"), true);
});

test("C2: a dead target retires the marker once, and a second apply is a no-op", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, DEFERRED_BOUNCE_BUSY_QUIET_MS + 1000);
  // The recorded pid is gone: the argv probe fails, so nothing is signalled.
  ctx.procs.matches.set(99, false);
  ctx.procs.hostPidList.length = 0;
  assert.equal(applyDeferredHostBounce(ctx.deps, {}, { nowMs: Date.now() }).kind, "skipped");
  const audits = auditRows(ctx).length;
  const again = applyDeferredHostBounce(ctx.deps, {}, { nowMs: Date.now() });
  assert.equal(again.kind, "skipped");
  if (again.kind === "skipped") assert.equal(again.reason, "no-marker");
  assert.equal(auditRows(ctx).length, audits);
  assert.deepEqual(ctx.procs.termed, []);
});

test("C3: a term that races with the supervisor never crashes the finalizer", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, DEFERRED_BOUNCE_BUSY_QUIET_MS + 1000);
  writeLease(ctx, { active: 0, updatedAt: Date.now() - DEFERRED_BOUNCE_BUSY_QUIET_MS, finishReason: "stop" });
  ctx.procs.termThrows = true;
  const outcome = applyDeferredHostBounce(ctx.deps, {}, { nowMs: Date.now() });
  assert.equal(outcome.kind, "applied");
  assert.equal(pendingHostBounce(ctx.deps), false);
});

test("C4: the marker's pids are the only targets; a replacement host is left alone", async () => {
  const ctx = setup([100]);
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, DEFERRED_BOUNCE_BUSY_QUIET_MS + 1000);
  // The recorded host is gone and whatever came back is a new pid.
  ctx.procs.hostPidList.length = 0;
  ctx.procs.hostPidList.push(200);
  ctx.procs.matches.set(100, false);
  ctx.procs.matches.set(200, true);
  for (let tick = 0; tick < 2; tick++) {
    const outcome = applyDeferredHostBounce(ctx.deps, {}, { nowMs: Date.now() });
    assert.equal(outcome.kind, "skipped");
  }
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(pendingHostBounce(ctx.deps), false);
});

test("C5: a host that started after the marker was armed is not bounced", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, DEFERRED_BOUNCE_BUSY_QUIET_MS + 1000);
  const marker = readPendingBounce(ctx.deps);
  assert.ok(marker);
  ctx.procs.starts.set(99, (marker?.armedAtMs ?? 0) + 60_000);
  const outcome = applyDeferredHostBounce(ctx.deps, {}, { nowMs: Date.now() });
  assert.equal(outcome.kind, "skipped");
  if (outcome.kind === "skipped") assert.equal(outcome.reason, "already-restarted");
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(pendingHostBounce(ctx.deps), false);
  assert.equal(auditRows(ctx).some((row) => row.to === "bounce:already-restarted"), true);
});

test("C6: a payload that moved on retires the marker even with --force", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, DEFERRED_BOUNCE_BUSY_QUIET_MS + 1000);
  // Another deploy replaced the executing payload: the marker names a payload
  // that no longer exists, so it must be dropped, not applied to a host it no
  // longer describes.
  ctx.fs.write(joinAbs(ctx.paths.repoRoot, "payload", "runtime.cjs"), "deployed-elsewhere");
  const outcome = applyDeferredHostBounce(ctx.deps, {}, { nowMs: Date.now(), force: true });
  assert.equal(outcome.kind, "skipped");
  if (outcome.kind === "skipped") assert.equal(outcome.reason, "stamp-changed");
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(pendingHostBounce(ctx.deps), false);
  assert.equal(auditRows(ctx).some((row) => row.to === "bounce:stale"), true);
});

test("C7: a host that came back with a new pid is never bounced by a stale marker", async () => {
  const ctx = setup([100]);
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  ageMarker(ctx, DEFERRED_BOUNCE_BUSY_QUIET_MS + 1000);
  const armedAt = readPendingBounce(ctx.deps)?.armedAtMs ?? 0;
  // Reboot or supervisor relaunch: the host runs again, but on a process that
  // started after the marker was armed, so it already has the new payload.
  ctx.procs.matches.set(100, true);
  ctx.procs.starts.set(100, armedAt + 30_000);
  const outcome = applyDeferredHostBounce(ctx.deps, {}, { nowMs: Date.now() });
  assert.equal(outcome.kind, "skipped");
  if (outcome.kind === "skipped") assert.equal(outcome.reason, "already-restarted");
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(pendingHostBounce(ctx.deps), false);
});

test("C8: a corrupt marker is retired loudly, never re-read forever", async () => {
  const ctx = setup();
  ctx.fs.write(ctx.paths.pendingBounce, "{not json");
  const outcome = applyDeferredHostBounce(ctx.deps, {}, { nowMs: Date.now() });
  assert.equal(outcome.kind, "skipped");
  if (outcome.kind === "skipped") assert.equal(outcome.reason, "corrupt-marker");
  assert.equal(pendingHostBounce(ctx.deps), false);
  assert.equal(auditRows(ctx).some((row) => row.to === "bounce:corrupt"), true);
});

test("C9: arming writes the marker with tmp + rename, never in place", async () => {
  const ctx = setup();
  await reconcile(zhipu(ctx.paths), ctx.deps, DEFER);
  assert.equal(ctx.fs.renames.length, 1);
  const [swap] = ctx.fs.renames;
  assert.equal(swap?.to, ctx.paths.pendingBounce);
  assert.match(swap?.from ?? "", /openbot-pending-bounce\.json\.\d+\.tmp$/);
  // The temp file is gone and the target holds the complete marker.
  assert.equal(ctx.fs.exists(swap?.from as never), false);
  assert.equal(
    Object.keys(ctx.fs.files).some((path) => path.endsWith(".tmp")),
    false,
  );
  assert.ok(readPendingBounce(ctx.deps));
});

test("C10: a marker that changes between reads is never retired as corrupt", async () => {
  const ctx = setup();
  ctx.fs.write(ctx.paths.pendingBounce, "{half-written");
  // The re-read returns different bytes: a concurrent arm replaced the file.
  ctx.fs.scriptedRead.set(ctx.paths.pendingBounce, {
    skip: 1,
    value: `${JSON.stringify({
      armedAt: new Date().toISOString(),
      armedAtMs: Date.now(),
      fingerprint: "aaaaaaaaaaaaaaaa",
      hostPids: [99],
      source: "test:concurrent",
    })}\n`,
  });
  const outcome = applyDeferredHostBounce(ctx.deps, {}, { nowMs: Date.now() });
  assert.equal(outcome.kind, "idle-pending");
  if (outcome.kind === "idle-pending") assert.equal(outcome.reason, "marker-changing");
  assert.equal(pendingHostBounce(ctx.deps), true, "a racing writer's marker must survive");
  assert.equal(auditRows(ctx).some((row) => row.to === "bounce:corrupt"), false);
});

test("C11: constant corrupt bytes are still retired with an audit line", async () => {
  const ctx = setup();
  ctx.fs.write(ctx.paths.pendingBounce, "{half-written");
  const outcome = applyDeferredHostBounce(ctx.deps, {}, { nowMs: Date.now() });
  assert.equal(outcome.kind, "skipped");
  if (outcome.kind === "skipped") assert.equal(outcome.reason, "corrupt-marker");
  assert.equal(pendingHostBounce(ctx.deps), false);
  assert.equal(auditRows(ctx).some((row) => row.to === "bounce:corrupt"), true);
});

test("A5b: a deferring official restore with logging off arms instead of bouncing", async () => {
  // A5 covers the logging-on tap. With logging off, official peels the wrap
  // back to the known backup, the other wrap-changing path.
  const ctx = setup();
  ctx.fs.write(ctx.paths.knownBackup, STOCK);
  const result = await reconcile(officialBox(ctx.paths), ctx.deps, DEFER);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.wrapBytesChanged, true);
  assert.equal(result.hostBounce, "deferred");
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(ctx.fs.read(ctx.paths.hostMain), STOCK);
  assert.equal(pendingHostBounce(ctx.deps), true);
});
