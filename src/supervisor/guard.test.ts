import assert from "node:assert/strict";
import test from "node:test";
import { OPENBOT_MARKER, SERVICE_PORT } from "../domain/types.ts";
import { wrapHostSource } from "../host/wrap.ts";
import { customBoxFromProvider, parseUpstreamOrigin } from "../parse/argv.ts";
import { compileCustomPlan, planToJson } from "./plan.ts";
import { boxPathsFrom, joinAbs } from "./paths.ts";
import { type FsDeps, type ProcDeps, parseOwnedPid } from "./procs.ts";
import { guardCustom } from "./guard.ts";

const STOCK = `function createProtoSessionProvider(client) {
  return { getSession: function () { return 1; } };
}
`;

const ORIGIN = parseUpstreamOrigin("https://open.bigmodel.cn/api/paas/v4");

type FakeProcs = ProcDeps & { started: string[]; stopped: number[]; termed: number[]; checked: string[] };

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
      if (src !== undefined) {
        files[to] = src;
      }
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

function fakeProcs(state: { serviceOurs?: boolean; syntaxFail?: boolean }): FakeProcs {
  let serviceOurs = state.serviceOurs === true;
  let uiPid: number | undefined = serviceOurs ? 43 : undefined;
  const started: string[] = [];
  const stopped: number[] = [];
  const termed: number[] = [];
  const checked: string[] = [];
  const procs: FakeProcs = {
    started,
    stopped,
    termed,
    checked,
    async port(_host, port) {
      if (port === SERVICE_PORT) {
        return serviceOurs;
      }
      return false;
    },
    readPidFile(path) {
      if (String(path).endsWith("openbot-ui.pid")) {
        return uiPid;
      }
      return undefined;
    },
    pidAlive(pid) {
      return pid === uiPid;
    },
    start(input) {
      started.push(input.argv.join(" "));
      serviceOurs = true;
      uiPid = 43;
      return parseOwnedPid(43);
    },
    stop(pid) {
      stopped.push(pid);
      if (pid === uiPid) {
        serviceOurs = false;
        uiPid = undefined;
      }
    },
    hostPids() {
      return [parseOwnedPid(99)];
    },
    opengrokHopPids() {
      return [];
    },
    term(pid) {
      termed.push(pid);
    },
    syntaxCheck(file) {
      checked.push(String(file));
      if (state.syntaxFail === true) {
        return { ok: false, stderr: "syntax boom" };
      }
      return { ok: true };
    },
  };
  return procs;
}

function setup(hostSource: string, procsState: Parameters<typeof fakeProcs>[0] = {}) {
  const paths = boxPathsFrom({
    repoRoot: "/tmp/openbot-test-repo",
    sandData: "/tmp/openbot-test-data",
    hostMain: "/tmp/openbot-test-host/host-main.cjs",
  });
  const fs = memoryFs({ [paths.hostMain]: hostSource });
  const procs = fakeProcs(procsState);
  return { deps: { paths, fs, procs }, fs, procs, paths };
}

function markedHost(): string {
  const wrapped = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(wrapped.kind, "wrapped");
  if (wrapped.kind !== "wrapped") {
    throw new Error("wrap proof failed");
  }
  return wrapped.source;
}

function zhipuPlan(paths: ReturnType<typeof setup>["paths"]): string {
  return planToJson(
    compileCustomPlan(
      customBoxFromProvider({ paths, origin: ORIGIN, name: "Zhipu", modelSlug: "glm-5.3-flash" }),
    ),
  );
}

type AuditRow = { ts: string; action: string; from: string; to: string; source: string };

function auditRows(ctx: ReturnType<typeof setup>): AuditRow[] {
  const raw = ctx.fs.read(joinAbs(ctx.paths.sandData, "openbot-audit.jsonl")) ?? "";
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AuditRow);
}

function recordModeWrites(ctx: ReturnType<typeof setup>): string[] {
  const writes: string[] = [];
  const base = ctx.deps.fs;
  ctx.deps.fs = {
    ...base,
    write(path, body, mode) {
      if (path === ctx.paths.mode) {
        writes.push(body);
      }
      base.write(path, body, mode);
    },
  };
  return writes;
}

test("guard repairs a corrupt mode file back to custom and keeps the wrap", async () => {
  const ctx = setup(markedHost());
  ctx.fs.write(ctx.paths.mode, "junk\n");
  ctx.fs.write(ctx.paths.plan, zhipuPlan(ctx.paths));
  const writes = recordModeWrites(ctx);
  const result = await guardCustom(ctx.deps);
  assert.equal(result.ok, true);
  assert.equal(result.detail, "repaired");
  assert.equal(result.modeRepaired, true);
  assert.equal(result.wrapRepaired, false);
  assert.equal(result.reconcile?.kind, "ok");
  assert.equal(ctx.fs.read(ctx.paths.mode)?.trim(), "custom");
  assert.equal(ctx.fs.read(ctx.paths.hostMain)?.includes(OPENBOT_MARKER), true);
  assert.equal(writes.every((body) => body === "custom\n"), true);
  assert.equal(ctx.procs.started.some((row) => row.includes("hop-server")), false);
});

test("guard reinstalls the wrap when the host is stock-unmarked while mode is custom", async () => {
  const ctx = setup(STOCK);
  ctx.fs.write(ctx.paths.mode, "custom\n");
  ctx.fs.write(ctx.paths.plan, zhipuPlan(ctx.paths));
  const result = await guardCustom(ctx.deps);
  assert.equal(result.ok, true);
  assert.equal(result.detail, "repaired");
  assert.equal(result.modeRepaired, false);
  assert.equal(result.wrapRepaired, true);
  assert.equal(result.reconcile?.kind, "ok");
  assert.equal(ctx.fs.read(ctx.paths.hostMain)?.includes(OPENBOT_MARKER), true);
  assert.equal(ctx.fs.read(ctx.paths.knownBackup), STOCK);
  assert.equal(ctx.fs.read(ctx.paths.mode)?.trim(), "custom");
  assert.equal(ctx.procs.started.some((row) => row.includes("server.ts")), true);
});

test("guard is a no-op when custom state is live", async () => {
  const ctx = setup(markedHost());
  ctx.fs.write(ctx.paths.mode, "custom\n");
  const plan = zhipuPlan(ctx.paths);
  ctx.fs.write(ctx.paths.plan, plan);
  const result = await guardCustom(ctx.deps);
  assert.deepEqual(result, {
    modeRepaired: false,
    wrapRepaired: false,
    ok: true,
    detail: "healthy",
    reconcile: undefined,
  });
  assert.equal(ctx.fs.read(ctx.paths.mode), "custom\n");
  assert.equal(ctx.fs.read(ctx.paths.plan), plan);
  assert.equal(ctx.procs.started.length, 0);
  assert.equal(ctx.procs.termed.length, 0);
  assert.equal(ctx.fs.exists(joinAbs(ctx.paths.sandData, "openbot-audit.jsonl")), false);
});

test("guard audit lines carry the guard source for each repair", async () => {
  const ctx = setup(STOCK);
  ctx.fs.write(ctx.paths.mode, "custom\n");
  ctx.fs.write(ctx.paths.plan, zhipuPlan(ctx.paths));
  const result = await guardCustom(ctx.deps);
  assert.equal(result.ok, true);
  const rows = auditRows(ctx);
  assert.deepEqual(rows.map((row) => row.action), ["backup", "wrap", "mode", "plan"]);
  assert.equal(rows.every((row) => row.source === "guard"), true);
  const wrap = rows.find((row) => row.action === "wrap");
  assert.equal(wrap?.from, "stock-unmarked");
  assert.equal(wrap?.to, "openbot-marked");
});

test("guard never writes the official token when the mode file says official", async () => {
  const ctx = setup(markedHost());
  ctx.fs.write(ctx.paths.mode, "official\n");
  ctx.fs.write(ctx.paths.plan, zhipuPlan(ctx.paths));
  const writes = recordModeWrites(ctx);
  const result = await guardCustom(ctx.deps);
  assert.equal(result.ok, true);
  assert.equal(result.modeRepaired, true);
  assert.equal(ctx.fs.read(ctx.paths.mode)?.trim(), "custom");
  assert.equal(writes.every((body) => !body.includes("official")), true);
  assert.equal(ctx.fs.read(ctx.paths.hostMain)?.includes(OPENBOT_MARKER), true);
});

test("guard does nothing when there is no custom state to repair to", async () => {
  const ctx = setup(markedHost());
  ctx.fs.write(ctx.paths.mode, "official\n");
  const result = await guardCustom(ctx.deps);
  assert.deepEqual(result, {
    modeRepaired: false,
    wrapRepaired: false,
    ok: false,
    detail: "no-custom-state",
    reconcile: undefined,
  });
  assert.equal(ctx.fs.read(ctx.paths.mode)?.trim(), "official");
  assert.equal(ctx.fs.read(ctx.paths.hostMain)?.includes(OPENBOT_MARKER), true);
  assert.equal(auditRows(ctx).length, 0);
  assert.equal(ctx.procs.started.length, 0);
});
