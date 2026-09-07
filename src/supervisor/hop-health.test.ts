import assert from "node:assert/strict";
import test from "node:test";
import { type FsDeps, type ProcDeps, parseOwnedPid } from "./procs.ts";
import { boxPathsFrom, joinAbs, type BoxPaths } from "./paths.ts";
import { DEFAULT_HOP_FAILURE_THRESHOLD, hopTargetFromEnv, runHopHealthCheck } from "./hop-health.ts";

type FakeProcs = ProcDeps & {
  started: Array<{ argv: readonly string[]; env: NodeJS.ProcessEnv; pidFile: string; log: string }>;
  portOpen: boolean;
};

function memoryFs(init: Record<string, string> = {}): FsDeps & { files: Record<string, string> } {
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

function fakeProcs(portOpen: boolean): FakeProcs {
  return {
    started: [],
    portOpen,
    async port() {
      return this.portOpen;
    },
    readPidFile() {
      return undefined;
    },
    pidAlive() {
      return false;
    },
    start(input) {
      this.started.push({ argv: input.argv, env: input.env, pidFile: String(input.pidFile), log: String(input.log) });
      return parseOwnedPid(4321);
    },
    stop() {},
    hostPids() {
      return [];
    },
    opengrokHopPids() {
      return [];
    },
    term() {},
    syntaxCheck() {
      return { ok: true };
    },
  };
}

function setup(portOpen: boolean) {
  const paths: BoxPaths = boxPathsFrom({
    repoRoot: "/tmp/openbot-hop-repo",
    sandData: "/tmp/openbot-hop-data",
    hostMain: "/tmp/openbot-hop-host/host-main.cjs",
  });
  const fs = memoryFs();
  const procs = fakeProcs(portOpen);
  return { deps: { paths, fs, procs }, fs, procs, paths };
}

type AuditRow = { action: string; from: string; to: string; source: string };

function auditRows(ctx: ReturnType<typeof setup>): AuditRow[] {
  const statePath = joinAbs(ctx.paths.sandData, "openbot-hop-health.json");
  void statePath;
  const auditPath = joinAbs(ctx.paths.sandData, "openbot-audit.jsonl");
  const raw = ctx.fs.read(auditPath) ?? "";
  return raw
    .split(String.fromCharCode(10))
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AuditRow);
}

test("hopTargetFromEnv mirrors runtime.hopUrl defaults", () => {
  const target = hopTargetFromEnv({});
  assert.deepEqual(target, { host: "127.0.0.1", port: 9280 });
  const custom = hopTargetFromEnv({ OPENBOT_HOP_HOST: "0.0.0.0", OPENBOT_HOP_PORT: "18790" });
  assert.deepEqual(custom, { host: "0.0.0.0", port: 18790 });
  const junk = hopTargetFromEnv({ OPENBOT_HOP_PORT: "not-a-number" });
  assert.equal(junk.port, 9280);
});

test("threshold default is two consecutive failures", () => {
  assert.equal(DEFAULT_HOP_FAILURE_THRESHOLD, 2);
});

test("an open hop port reports healthy and resets the failure streak", async () => {
  const ctx = setup(true);
  const statePath = joinAbs(ctx.paths.sandData, "openbot-hop-health.json");
  ctx.fs.write(statePath, JSON.stringify({ failures: 1 }));
  const out = await runHopHealthCheck(ctx.deps, { target: { host: "127.0.0.1", port: 9280 } });
  assert.equal(out.status, "healthy");
  assert.equal(out.failures, 0);
  assert.deepEqual(ctx.procs.started, []);
  assert.deepEqual(auditRows(ctx), []);
  assert.equal(ctx.fs.read(statePath), JSON.stringify({ failures: 0 }));
});

test("one probe failure below the threshold only marks degraded", async () => {
  const ctx = setup(false);
  const out = await runHopHealthCheck(ctx.deps, { target: { host: "127.0.0.1", port: 9280 } });
  assert.equal(out.status, "degraded");
  assert.equal(out.failures, 1);
  assert.deepEqual(ctx.procs.started, []);
  assert.deepEqual(auditRows(ctx), []);
});

test("the second consecutive failure restarts hop-server and writes an audit row", async () => {
  const ctx = setup(false);
  const first = await runHopHealthCheck(ctx.deps, { target: { host: "127.0.0.1", port: 9280 } });
  assert.equal(first.status, "degraded");
  const second = await runHopHealthCheck(ctx.deps, { target: { host: "127.0.0.1", port: 9280 } });
  assert.equal(second.status, "restarted");
  assert.equal(second.pid, 4321);
  assert.equal(ctx.procs.started.length, 1);
  const start = ctx.procs.started[0];
  assert.ok(start);
  assert.equal(start.argv.join(" ").includes("hop-server"), true);
  assert.equal(start.env.OPENBOT_HOP_PORT, "9280");
  assert.equal(start.env.OPENBOT_HOP_PID, String(ctx.paths.hopPid));
  assert.equal(start.pidFile, String(ctx.paths.hopPid));
  assert.equal(start.log, String(ctx.paths.hopLog));
  assert.deepEqual(
    auditRows(ctx).map((row) => [row.action, row.from, row.to, row.source]),
    [["guard", "hop-down", "hop-restarted", "guard-daemon"]],
  );
  const counter = ctx.fs.read(joinAbs(ctx.paths.sandData, "openbot-hop-health.json"));
  assert.equal(counter, JSON.stringify({ failures: 0 }));
});

test("a custom threshold of one restarts on the first failure", async () => {
  const ctx = setup(false);
  const out = await runHopHealthCheck(ctx.deps, {
    target: { host: "127.0.0.1", port: 9280 },
    failureThreshold: 1,
  });
  assert.equal(out.status, "restarted");
  assert.equal(ctx.procs.started.length, 1);
});

test("after a restart the next healthy probe clears the streak", async () => {
  const ctx = setup(false);
  await runHopHealthCheck(ctx.deps, { target: { host: "127.0.0.1", port: 9280 } });
  await runHopHealthCheck(ctx.deps, { target: { host: "127.0.0.1", port: 9280 } });
  ctx.procs.portOpen = true;
  const out = await runHopHealthCheck(ctx.deps, { target: { host: "127.0.0.1", port: 9280 } });
  assert.equal(out.status, "healthy");
  assert.equal(ctx.procs.started.length, 1);
});
