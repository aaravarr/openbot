import assert from "node:assert/strict";
import test from "node:test";
import { OPENBOT_MARKER, type AbsPath, type Snapshot } from "./domain/types.ts";
import { payloadFingerprint } from "./host/payload-fingerprint.ts";
import { parseInstallCommand } from "./parse/argv.ts";
import { type FsDeps, type ProcDeps, parseOwnedPid } from "./supervisor/procs.ts";
import { boxPathsFrom } from "./supervisor/paths.ts";
import { DEFERRED_BOUNCE_GRACE_MS, armDeferredHostBounce, type HostBounce } from "./supervisor/reconcile.ts";
import { printFinalizeOutcome, runFinalizeHost } from "./cli.ts";
import { printResult } from "./cli/print.ts";

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

function fakeProcs(term: number[]): ProcDeps {
  return {
    async port() {
      return false;
    },
    readPidFile() {
      return undefined;
    },
    pidAlive() {
      return false;
    },
    start() {
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
      term.push(pid);
    },
    syntaxCheck() {
      return { ok: true };
    },
  };
}

function setup() {
  const paths = boxPathsFrom({
    repoRoot: "/tmp/openbot-finalize-repo",
    sandData: "/tmp/openbot-finalize-data",
    hostMain: "/tmp/openbot-finalize-host/host-main.cjs",
  });
  const fs = memoryFs({ [paths.hostMain]: "/* openbot-stock-wrap */\n" });
  const termed: number[] = [];
  return { deps: { paths, fs, procs: fakeProcs(termed) }, fs, termed, paths };
}

/** A lease that is idle: no request in flight, short quiet window. */
function writeIdleLease(ctx: ReturnType<typeof setup>, at: number): void {
  ctx.fs.write(
    ctx.paths.turnLease,
    `${JSON.stringify({ active: 0, lastStartAt: at, lastEndAt: at, lastFinishReason: "stop", updatedAt: at })}\n`,
  );
}

test("E1: finalize-host with no marker does nothing and says so", async () => {
  const ctx = setup();
  const outcome = await runFinalizeHost(ctx.deps, {
    once: true,
    force: false,
    stopQuietMs: 1000,
    busyQuietMs: 1000,
    graceMs: 1000,
    maxWaitMs: 5000,
    pollMs: 10,
  });
  assert.equal(outcome.kind, "skipped");
  assert.deepEqual(ctx.termed, []);
});

/** The fingerprint reconcile would compute for this fake tree. */
function currentFingerprint(ctx: ReturnType<typeof setup>): string {
  return payloadFingerprint({
    payloadDir: "/tmp/openbot-finalize-repo/payload",
    read: (path) => ctx.fs.read(path as AbsPath),
  });
}

/** Arm a valid marker, aged past every gate. */
function armOldMarker(ctx: ReturnType<typeof setup>, ageMs = 3_600_000): void {
  armDeferredHostBounce(ctx.deps, { source: "test" }, currentFingerprint(ctx));
  const marker = JSON.parse(ctx.fs.read(ctx.paths.pendingBounce) ?? "{}") as { armedAtMs: number };
  ctx.fs.write(
    ctx.paths.pendingBounce,
    `${JSON.stringify({ ...marker, armedAtMs: marker.armedAtMs - ageMs }, null, 2)}\n`,
  );
}

test("E2: finalize-host applies an idle bounce exactly once", async () => {
  const ctx = setup();
  const now = Date.now();
  armOldMarker(ctx);
  writeIdleLease(ctx, now - 3_600_000);
  const outcome = await runFinalizeHost(ctx.deps, {
    once: true,
    force: false,
    stopQuietMs: 1000,
    busyQuietMs: 1000,
    graceMs: 1000,
    maxWaitMs: 5000,
    pollMs: 10,
  });
  assert.equal(outcome.kind, "applied");
  assert.deepEqual(ctx.termed, [99]);
  assert.equal(ctx.fs.exists(ctx.paths.pendingBounce), false);
});

test("E2b: a marker whose payload moved on is retired without a kill", async () => {
  const ctx = setup();
  armOldMarker(ctx);
  writeIdleLease(ctx, Date.now() - 3_600_000);
  ctx.fs.write("/tmp/openbot-finalize-repo/payload/runtime.cjs" as AbsPath, "another-deploy");
  const outcome = await runFinalizeHost(ctx.deps, {
    once: true,
    force: false,
    stopQuietMs: 1000,
    busyQuietMs: 1000,
    graceMs: 1000,
    maxWaitMs: 5000,
    pollMs: 10,
  });
  assert.equal(outcome.kind, "skipped");
  assert.deepEqual(ctx.termed, []);
});

test("E3: finalize-host waits for the poll until the host is idle", async () => {
  const ctx = setup();
  const realNow = Date.now();
  const markerAt = realNow - 3_600_000;
  ctx.fs.write(
    ctx.paths.pendingBounce,
    `${JSON.stringify({ armedAt: new Date(markerAt).toISOString(), armedAtMs: markerAt, fingerprint: "x", hostPids: [99], source: "test" })}\n`,
  );
  writeIdleLease(ctx, markerAt);
  let clock = realNow;
  const slept: number[] = [];
  const outcome = await runFinalizeHost(ctx.deps, {
    once: false,
    force: false,
    stopQuietMs: 1000,
    busyQuietMs: 1000,
    graceMs: 1000,
    maxWaitMs: 60_000,
    pollMs: 250,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += 30_000;
    },
  });
  // A wrong stamp retires the marker before any kill, whatever the clock says.
  assert.equal(outcome.kind, "skipped");
  assert.deepEqual(ctx.termed, []);
  assert.equal(slept.length, 0);
});

test("E3b: the loop polls until the lease goes quiet", async () => {
  const ctx = setup();
  const realNow = Date.now();
  const markerAt = realNow - 3_600_000;
  ctx.fs.write(
    ctx.paths.pendingBounce,
    `${JSON.stringify({
      armedAt: new Date(markerAt).toISOString(),
      armedAtMs: markerAt,
      fingerprint: currentFingerprint(ctx),
      hostPids: [99],
      source: "test",
    })}\n`,
  );
  // A request is in flight at first; the poll sees it settle.
  ctx.fs.write(
    ctx.paths.turnLease,
    `${JSON.stringify({ active: 1, lastStartAt: realNow, lastEndAt: realNow, lastFinishReason: "tool_calls", updatedAt: realNow })}\n`,
  );
  let clock = realNow;
  const slept: number[] = [];
  const outcome = await runFinalizeHost(ctx.deps, {
    once: false,
    force: false,
    stopQuietMs: 1000,
    busyQuietMs: 1000,
    graceMs: 1000,
    maxWaitMs: 600_000,
    pollMs: 250,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += 60_000;
      ctx.fs.write(
        ctx.paths.turnLease,
        `${JSON.stringify({ active: 0, lastStartAt: realNow, lastEndAt: realNow, lastFinishReason: "stop", updatedAt: realNow })}\n`,
      );
    },
  });
  assert.deepEqual(slept, [250]);
  assert.equal(outcome.kind, "applied");
  assert.deepEqual(ctx.termed, [99]);
});

test("E3c: the loop gives up at max wait while a request is still in flight", async () => {
  const ctx = setup();
  const realNow = Date.now();
  const markerAt = realNow - 3_600_000;
  ctx.fs.write(
    ctx.paths.pendingBounce,
    `${JSON.stringify({
      armedAt: new Date(markerAt).toISOString(),
      armedAtMs: markerAt,
      fingerprint: currentFingerprint(ctx),
      hostPids: [99],
      source: "test",
    })}\n`,
  );
  ctx.fs.write(
    ctx.paths.turnLease,
    `${JSON.stringify({ active: 1, lastStartAt: realNow, lastEndAt: realNow, lastFinishReason: "tool_calls", updatedAt: realNow })}\n`,
  );
  let clock = realNow;
  const outcome = await runFinalizeHost(ctx.deps, {
    once: false,
    force: false,
    stopQuietMs: 1000,
    busyQuietMs: 1000,
    graceMs: 1000,
    maxWaitMs: 3000,
    pollMs: 1000,
    now: () => clock,
    sleep: async () => {
      clock += 40_000;
    },
  });
  assert.equal(outcome.kind, "idle-pending");
  if (outcome.kind === "idle-pending") assert.equal(outcome.reason, "turn-active");
  assert.deepEqual(ctx.termed, []);
});

test("E4: --once returns the held verdict without sleeping", async () => {
  const ctx = setup();
  const markerAt = Date.now();
  ctx.fs.write(
    ctx.paths.pendingBounce,
    `${JSON.stringify({ armedAt: new Date(markerAt).toISOString(), armedAtMs: markerAt, fingerprint: "x", hostPids: [99], source: "test" })}\n`,
  );
  let slept = 0;
  const outcome = await runFinalizeHost(ctx.deps, {
    once: true,
    force: false,
    stopQuietMs: 1000,
    busyQuietMs: 1000,
    graceMs: 1000,
    maxWaitMs: 60_000,
    pollMs: 250,
    now: () => markerAt,
    sleep: async () => {
      slept += 1;
    },
  });
  assert.equal(outcome.kind, "skipped");
  assert.equal(slept, 0);
});

test("E5: the CLI parses finalize-host and its bot alias", () => {
  const plain = parseInstallCommand({ argv: ["finalize-host"], env: {}, repoRoot: "/repo" });
  assert.equal(plain.command.kind, "finalize-host");
  if (plain.command.kind !== "finalize-host") return;
  assert.equal(plain.command.once, false);
  assert.equal(plain.command.force, false);

  const alias = parseInstallCommand({ argv: ["--bot-finalize"], env: {}, repoRoot: "/repo" });
  assert.equal(alias.command.kind, "finalize-host");
  if (alias.command.kind !== "finalize-host") return;
  assert.equal(alias.command.once, true);

  // The grace window defaults to 120 s and must stay there: it is what keeps
  // the first guard tick after an install from applying on a stale lease.
  assert.equal(plain.command.graceMs, DEFERRED_BOUNCE_GRACE_MS);
  assert.equal(DEFERRED_BOUNCE_GRACE_MS, 120_000);

  const tuned = parseInstallCommand({
    argv: [
      "finalize-host",
      "--wait-idle-ms",
      "1500",
      "--busy-wait-ms",
      "6000",
      "--max-wait-ms",
      "9000",
      "--grace-ms",
      "700",
      "--poll-ms",
      "50",
      "--force",
    ],
    env: {},
    repoRoot: "/repo",
  });
  assert.equal(tuned.command.kind, "finalize-host");
  if (tuned.command.kind !== "finalize-host") return;
  assert.deepEqual(
    [
      tuned.command.stopQuietMs,
      tuned.command.busyQuietMs,
      tuned.command.maxWaitMs,
      tuned.command.graceMs,
      tuned.command.pollMs,
      tuned.command.force,
    ],
    [1500, 6000, 9000, 700, 50, true],
  );

  assert.throws(
    () => parseInstallCommand({ argv: ["finalize-host", "--wait-idle-ms", "soon"], env: {}, repoRoot: "/repo" }),
    /milliseconds/,
  );
});

test("E6: the install command only defers when it is asked to", () => {
  const plain = parseInstallCommand({ argv: ["install"], env: {}, repoRoot: "/repo" });
  assert.equal(plain.command.kind, "install");
  if (plain.command.kind !== "install") return;
  assert.equal(plain.command.deferHostBounce, false);

  const flagged = parseInstallCommand({ argv: ["install", "--defer-host-bounce"], env: {}, repoRoot: "/repo" });
  if (flagged.command.kind !== "install") return;
  assert.equal(flagged.command.deferHostBounce, true);

  const env = parseInstallCommand({ argv: ["install"], env: { OPENBOT_DEFER_HOST_BOUNCE: "1" }, repoRoot: "/repo" });
  if (env.command.kind !== "install") return;
  assert.equal(env.command.deferHostBounce, true);
});

test("E7: finalize outcome text is explicit for each verdict", () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    printFinalizeOutcome({ kind: "applied", pids: [99], forced: false }, false);
    printFinalizeOutcome({ kind: "applied", pids: [99], forced: true }, false);
    printFinalizeOutcome({ kind: "skipped", reason: "no-marker" }, false);
    printFinalizeOutcome({ kind: "idle-pending", reason: "turn-active" }, false);
  } finally {
    console.log = orig;
  }
  assert.match(lines[0] ?? "", /host is idle/);
  assert.match(lines[1] ?? "", /max wait passed/);
  assert.match(lines[2] ?? "", /no deferred host bounce/);
  assert.match(lines[3] ?? "", /still waiting/);
});

test("E8: printResult reports hostBounce for every outcome", () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  const snapshot: Snapshot = {
    wrap: { kind: "openbot-marked", marker: OPENBOT_MARKER },
    hopListen: { kind: "absent" },
    uiListen: { kind: "absent" },
    host: { kind: "absent" },
    alignment: { kind: "ok", desired: "custom", wrap: "openbot-marked" },
    tunnel: { kind: "off" },
  };
  try {
    for (const hostBounce of ["none", "done", "deferred"] as HostBounce[]) {
      printResult({ kind: "ok", snapshot, wrapBytesChanged: hostBounce !== "none", hostBounce }, true);
    }
  } finally {
    console.log = orig;
  }
  assert.deepEqual(
    lines.map((line) => (JSON.parse(line) as { hostBounce: string }).hostBounce),
    ["none", "done", "deferred"],
  );
});
