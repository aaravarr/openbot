import assert from "node:assert/strict";
import test from "node:test";
import { OPENBOT_MARKER, OPENGROK_MARKER, SERVICE_PORT } from "../domain/types.ts";
import { wrapHostSource } from "../host/wrap.ts";
import { customBoxFromProvider, officialBox, parseUpstreamOrigin } from "../parse/argv.ts";
import { boxPathsFrom, parseAbsPath } from "./paths.ts";
import { type FsDeps, type ProcDeps, parseOwnedPid } from "./procs.ts";
import { reconcile } from "./reconcile.ts";

const STOCK = `function createProtoSessionProvider(client) {
  return { getSession: function () { return 1; } };
}
`;

const ORIGIN = parseUpstreamOrigin("https://open.bigmodel.cn/api/paas/v4");

type FakeProcs = ProcDeps & { started: string[]; stopped: number[]; termed: number[]; checked: string[] };

function opengrokWrap(stock: string): string {
  return (
    `${OPENGROK_MARKER}\n` +
    `var __opengrokRuntime = require("/home/box/sand-data/opengrok-runtime.cjs");\n` +
    `function createProtoSessionProvider() {\n` +
    `  return __opengrokRuntime.wrapSession(createProtoSessionProvider_stock, arguments);\n` +
    `}\n` +
    stock.replaceAll("function createProtoSessionProvider(", "function createProtoSessionProvider_stock(")
  );
}

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

function fakeProcs(state: {
  serviceOurs?: boolean;
  serviceForeign?: boolean;
  leftoverHop?: boolean;
  staleUi?: boolean;
  opengrokHop?: boolean;
  syntaxFail?: boolean;
}): FakeProcs {
  let serviceOurs = state.serviceOurs === true;
  let serviceForeign = state.serviceForeign === true;
  let leftoverHop = state.leftoverHop === true;
  let hopPid: number | undefined = leftoverHop ? 42 : undefined;
  let uiPid: number | undefined = serviceOurs || state.staleUi === true ? 43 : undefined;
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
        return serviceOurs || serviceForeign;
      }
      return false;
    },
    readPidFile(path) {
      if (String(path).endsWith("openbot-hop.pid")) {
        return hopPid;
      }
      if (String(path).endsWith("openbot-ui.pid")) {
        return uiPid;
      }
      return undefined;
    },
    pidAlive(pid) {
      return pid === hopPid || pid === uiPid;
    },
    start(input) {
      started.push(input.argv.join(" "));
      serviceOurs = true;
      serviceForeign = false;
      uiPid = 43;
      return parseOwnedPid(43);
    },
    stop(pid) {
      stopped.push(pid);
      if (pid === hopPid) {
        leftoverHop = false;
        hopPid = undefined;
      }
      if (pid === uiPid) {
        serviceOurs = false;
        uiPid = undefined;
      }
    },
    hostPids() {
      return [parseOwnedPid(99)];
    },
    opengrokHopPids() {
      if (state.opengrokHop === true) {
        return [parseOwnedPid(7)];
      }
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

function zhipu(paths: ReturnType<typeof setup>["paths"]) {
  return customBoxFromProvider({
    paths,
    origin: ORIGIN,
    name: "Zhipu",
    modelSlug: "glm-5.3-flash",
  });
}

test("custom wrap writes the marker, backs up stock, and starts the loopback service", async () => {
  const ctx = setup(STOCK);
  const result = await reconcile(zhipu(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  const written = ctx.fs.read(ctx.paths.hostMain);
  assert.equal(written?.includes(OPENBOT_MARKER), true);
  assert.equal(ctx.fs.read(ctx.paths.knownBackup), STOCK);
  const plan = ctx.fs.read(ctx.paths.plan);
  assert.equal(plan?.includes("apiKey"), false);
  assert.equal(plan?.includes("hopBaseUrl"), true);
  assert.match(plan ?? "", /9280/);
  assert.equal(ctx.fs.read(ctx.paths.mode)?.trim(), "custom");
  assert.equal(ctx.procs.started.some((row) => row.includes("hop-server")), false);
  assert.equal(ctx.procs.started.some((row) => row.includes("server.ts")), true);
  assert.equal(ctx.procs.termed.length, 1);
});

test("wrap syntax-check temp file ends in .cjs", async () => {
  const ctx = setup(STOCK);
  const result = await reconcile(zhipu(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  assert.equal(ctx.procs.checked.length, 1);
  assert.match(ctx.procs.checked[0] ?? "", /host-main\.openbot-check\.cjs$/);
});

test("syntax-check-failed leaves the stock host unwrapped", async () => {
  const ctx = setup(STOCK, { syntaxFail: true });
  const result = await reconcile(zhipu(ctx.paths), ctx.deps);
  assert.equal(result.kind, "refused");
  if (result.kind === "refused") {
    assert.equal(result.error.kind, "syntax-check-failed");
  }
  assert.equal(ctx.fs.read(ctx.paths.hostMain), STOCK);
  assert.equal(ctx.fs.read(ctx.paths.hostMain)?.includes(OPENBOT_MARKER), false);
});

test("official restores the backup and does not wrap identity", async () => {
  const wrapped = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(wrapped.kind, "wrapped");
  if (wrapped.kind !== "wrapped") {
    return;
  }
  const ctx = setup(wrapped.source);
  ctx.fs.write(ctx.paths.knownBackup, STOCK);
  const result = await reconcile(officialBox(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  assert.equal(ctx.fs.read(ctx.paths.hostMain), STOCK);
  assert.equal(ctx.fs.read(ctx.paths.hostMain)?.includes(OPENBOT_MARKER), false);
  assert.equal(ctx.fs.read(ctx.paths.mode)?.trim(), "official");
});

test("official keeps the catalog plan file", async () => {
  const wrapped = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(wrapped.kind, "wrapped");
  if (wrapped.kind !== "wrapped") {
    return;
  }
  const ctx = setup(wrapped.source);
  ctx.fs.write(ctx.paths.knownBackup, STOCK);
  ctx.fs.write(ctx.paths.plan, '{"kind":"custom","catalog":{"providers":[{"id":"zhipu"}],"models":[],"bindings":[]}}\n');
  const result = await reconcile(officialBox(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  assert.match(ctx.fs.read(ctx.paths.plan) ?? "", /zhipu/);
  if (result.kind === "ok") {
    assert.equal(result.snapshot.alignment.kind, "ok");
  }
});

test("official peels a known opengrok wrap back to stock", async () => {
  const ctx = setup(opengrokWrap(STOCK));
  const result = await reconcile(officialBox(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  assert.equal(ctx.fs.read(ctx.paths.hostMain), STOCK);
  assert.equal(ctx.fs.read(ctx.paths.hostMain)?.includes(OPENGROK_MARKER), false);
});

test("custom wrap peels opengrok first and backs up stock, not the leftover wrap", async () => {
  const ctx = setup(opengrokWrap(STOCK));
  const result = await reconcile(zhipu(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  assert.equal(ctx.fs.read(ctx.paths.knownBackup), STOCK);
  assert.equal(ctx.fs.read(ctx.paths.hostMain)?.includes(OPENBOT_MARKER), true);
  assert.equal(ctx.fs.read(ctx.paths.hostMain)?.includes(OPENGROK_MARKER), false);
});

test("official on an unmarked vendor rewrite does not restore an old backup", async () => {
  const vendor = `function createProtoSessionProvider(client) { return "v2"; }\n`;
  const ctx = setup(vendor);
  ctx.fs.write(ctx.paths.knownBackup, STOCK);
  const result = await reconcile(officialBox(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  assert.equal(ctx.fs.read(ctx.paths.hostMain), vendor);
});

test("foreign listener on the service port is refused, not adopted", async () => {
  const ctx = setup(STOCK, { serviceForeign: true });
  const result = await reconcile(zhipu(ctx.paths), ctx.deps);
  assert.equal(result.kind, "refused");
  if (result.kind === "refused") {
    assert.equal(result.error.kind, "foreign-hop");
  }
});

test("leftover opengrok hop-server.py is stopped, not adopted", async () => {
  const ctx = setup(STOCK, { opengrokHop: true });
  const result = await reconcile(zhipu(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  assert.equal(ctx.procs.stopped.includes(7), true);
  assert.equal(ctx.procs.started.some((row) => row.includes("hop-server")), false);
  assert.equal(ctx.procs.started.some((row) => row.includes("server.ts")), true);
});

test("official stops leftover opengrok hop-server.py and does not start a hop process", async () => {
  const ctx = setup(opengrokWrap(STOCK), { opengrokHop: true });
  const result = await reconcile(officialBox(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  assert.equal(ctx.fs.read(ctx.paths.hostMain), STOCK);
  assert.equal(ctx.procs.stopped.includes(7), true);
  assert.equal(ctx.procs.started.some((row) => row.includes("hop-server")), false);
});

test("leftover hop-server.cjs is stopped when the service is unified", async () => {
  const ctx = setup(STOCK, { leftoverHop: true });
  const result = await reconcile(zhipu(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  assert.equal(ctx.procs.stopped.includes(42), true);
  assert.equal(ctx.fs.exists(ctx.paths.hopPid), false);
  assert.equal(ctx.procs.started.some((row) => row.includes("hop-server")), false);
});

test("stale UI on the old two-port layout is stopped and replaced", async () => {
  const ctx = setup(STOCK, { staleUi: true });
  const result = await reconcile(zhipu(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  assert.equal(ctx.procs.stopped.includes(43), true);
  assert.equal(ctx.procs.started.some((row) => row.includes("server.ts")), true);
});

test("private-lane host is not wrapped", async () => {
  const ctx = setup(STOCK + "\ncreateOpenAiHopSession();\nresolvedOpenaiBaseUrl();\n");
  const result = await reconcile(zhipu(ctx.paths), ctx.deps);
  assert.equal(result.kind, "refused");
});

test("owned service is adopted, not started again", async () => {
  const wrapped = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(wrapped.kind, "wrapped");
  if (wrapped.kind !== "wrapped") {
    return;
  }
  const ctx = setup(wrapped.source, { serviceOurs: true });
  const result = await reconcile(zhipu(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  assert.equal(ctx.procs.started.length, 0);
});

void parseAbsPath;
