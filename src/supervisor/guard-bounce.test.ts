import assert from "node:assert/strict";
import test from "node:test";
import { wrapHostSource } from "../host/wrap.ts";
import { customBoxFromProvider, parseUpstreamOrigin } from "../parse/argv.ts";
import { type FsDeps, type ProcDeps, parseOwnedPid } from "./procs.ts";
import { boxPathsFrom, joinAbs } from "./paths.ts";
import { runGuardTickWithHopHealth } from "./guard-daemon.ts";
import type { GuardResult } from "./guard.ts";
import {
  DEFERRED_BOUNCE_BUSY_QUIET_MS,
  DEFERRED_BOUNCE_GRACE_MS,
  applyDeferredHostBounce,
  armDeferredHostBounce,
  readPendingBounce,
  reconcile,
} from "./reconcile.ts";

const STOCK = `function createProtoSessionProvider(client) {
  return { getSession: function () { return 1; } };
}
`;

const ORIGIN = parseUpstreamOrigin("https://open.bigmodel.cn/api/paas/v4");

/** A legacy-marked host, so a reconcile always sees a wrap change. */
function legacyWrapped(): string {
  const proof = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(proof.kind, "wrapped");
  if (proof.kind !== "wrapped") throw new Error("wrap failed in fixture");
  return proof.source;
}

function zhipu(paths: ReturnType<typeof setup>["paths"]) {
  return customBoxFromProvider({ paths, origin: ORIGIN, name: "Zhipu", modelSlug: "glm-5.3-flash" });
}

const HEALTHY: GuardResult = {
  modeRepaired: false,
  wrapRepaired: false,
  ok: true,
  detail: "healthy",
  reconcile: undefined,
};

type FakeProcs = ProcDeps & { termed: number[]; finalizePid: number | undefined; live: Set<number> };

function memoryFs(init: Record<string, string>): FsDeps & { files: Record<string, string> } {
  const files: Record<string, string> = { ...init };
  return {
    files,
    read(path) {
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
  };
}

function fakeProcs(): FakeProcs {
  let up = false;
  let uiPid: number | undefined;
  const procs: FakeProcs = {
    termed: [],
    finalizePid: undefined,
    live: new Set<number>(),
    async port() {
      return up;
    },
    readPidFile(path) {
      if (String(path).endsWith("openbot-finalize.pid")) {
        return procs.finalizePid;
      }
      if (String(path).endsWith("openbot-ui.pid")) {
        return uiPid;
      }
      return undefined;
    },
    pidAlive(pid) {
      return procs.live.has(pid) || pid === uiPid;
    },
    start() {
      up = true;
      uiPid = 43;
      return parseOwnedPid(43);
    },
    stop() {},
    hostPids() {
      return [parseOwnedPid(99)];
    },
    hostPidMatches() {
      return true;
    },
    opengrokHopPids() {
      return [];
    },
    term(pid) {
      procs.termed.push(pid);
    },
    syntaxCheck() {
      return { ok: true };
    },
  };
  return procs;
}

function setup() {
  const paths = boxPathsFrom({
    repoRoot: "/tmp/openbot-guard-bounce-repo",
    sandData: "/tmp/openbot-guard-bounce-data",
    hostMain: "/tmp/openbot-guard-bounce-host/host-main.cjs",
  });
  const fs = memoryFs({ [paths.hostMain]: legacyWrapped() });
  const procs = fakeProcs();
  return { deps: { paths, fs, procs }, fs, procs, paths };
}

type Ctx = ReturnType<typeof setup>;

/** Arm a marker through a real deferred reconcile, with an explicit age. */
async function arm(ctx: Ctx, ageMs: number): Promise<void> {
  await reconcile(zhipu(ctx.paths), ctx.deps, { deferHostBounce: true, source: "test:install" });
  const marker = readPendingBounce(ctx.deps);
  assert.ok(marker, "marker must be armed");
  if (!marker) return;
  ctx.fs.write(
    ctx.paths.pendingBounce,
    `${JSON.stringify({ ...marker, armedAtMs: marker.armedAtMs - ageMs }, null, 2)}\n`,
  );
}

/** A lease that says "no hop request in flight, last one just finished". */
function writeLease(ctx: Ctx, updatedAt: number, finishReason?: string): void {
  ctx.fs.write(
    ctx.paths.turnLease,
    `${JSON.stringify({ active: 0, lastStartAt: updatedAt, lastEndAt: updatedAt, lastFinishReason: finishReason, updatedAt })}\n`,
  );
}

async function tick(ctx: Ctx, runOnce?: () => Promise<GuardResult>): Promise<string[]> {
  const lines: string[] = [];
  await runGuardTickWithHopHealth(ctx.deps, {
    runOnce: runOnce ?? (async () => HEALTHY),
    stderr: (line) => lines.push(line),
    hopHealth: false,
  });
  return lines;
}

test("D1: a live finalizer keeps the guard tick from applying the bounce", async () => {
  const ctx = setup();
  await arm(ctx, DEFERRED_BOUNCE_BUSY_QUIET_MS + 1000);
  writeLease(ctx, Date.now() - DEFERRED_BOUNCE_BUSY_QUIET_MS, "stop");
  ctx.procs.finalizePid = 4242;
  ctx.procs.live.add(4242);
  await tick(ctx);
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(readPendingBounce(ctx.deps) !== undefined, true);
});

test("D2: a dead finalizer makes the guard apply the bounce exactly once", async () => {
  const ctx = setup();
  await arm(ctx, DEFERRED_BOUNCE_BUSY_QUIET_MS + 1000);
  writeLease(ctx, Date.now() - DEFERRED_BOUNCE_BUSY_QUIET_MS, "stop");
  ctx.procs.finalizePid = 4242;
  await tick(ctx);
  await tick(ctx);
  assert.deepEqual(ctx.procs.termed, [99]);
  assert.equal(readPendingBounce(ctx.deps) === undefined, true);
});

test("D4/X1: the first guard tick after an install never kills a fresh marker without a lease", async () => {
  const ctx = setup();
  await arm(ctx, 1000);
  ctx.procs.finalizePid = 4242;
  const lines = await tick(ctx);
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(readPendingBounce(ctx.deps) !== undefined, true);
  assert.equal(lines.some((line) => line.includes("applied a deferred host bounce")), false);
});

test("D3: a guard tick never rewrites the marker's armedAt", async () => {
  const ctx = setup();
  await arm(ctx, 10_000);
  const before = readPendingBounce(ctx.deps);
  await tick(ctx);
  const after = readPendingBounce(ctx.deps);
  assert.equal(after?.armedAtMs, before?.armedAtMs);
});

test("D5: a tick with no marker behaves exactly as before", async () => {
  const ctx = setup();
  await tick(ctx);
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(ctx.fs.exists(joinAbs(ctx.paths.sandData, "openbot-audit.jsonl")), false);
});

test("D6: a guard-triggered repair honours an already armed marker", async () => {
  const ctx = setup();
  await arm(ctx, DEFERRED_BOUNCE_GRACE_MS + 1000);
  const armedAt = readPendingBounce(ctx.deps)?.armedAtMs;
  // Another payload deploy rewrote the host file while the marker is pending.
  ctx.fs.write(ctx.paths.hostMain, legacyWrapped());
  // The repair path is a reconcile without the defer flag; while a marker is
  // pending it must refresh the marker instead of jumping the queue.
  const result = await reconcile(zhipu(ctx.paths), ctx.deps, { source: "guard" });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.hostBounce, "deferred");
  assert.deepEqual(ctx.procs.termed, []);
  assert.equal(readPendingBounce(ctx.deps)?.armedAtMs, armedAt);
});

test("D7: applyDeferredHostBounce is a no-op once the marker is gone", async () => {
  const ctx = setup();
  const first = applyDeferredHostBounce(ctx.deps);
  assert.equal(first.kind, "skipped");
  if (first.kind === "skipped") assert.equal(first.reason, "no-marker");
  assert.deepEqual(ctx.procs.termed, []);
});

test("D8: the exported arm helper records the stamp and targets it was armed with", async () => {
  const ctx = setup();
  armDeferredHostBounce(ctx.deps, { source: "test:install" }, "aaaaaaaabbbbbbbb");
  const marker = readPendingBounce(ctx.deps);
  assert.equal(marker?.fingerprint, "aaaaaaaabbbbbbbb");
  assert.deepEqual(marker?.hostPids, [99]);
  assert.equal(marker?.source, "test:install");
});
