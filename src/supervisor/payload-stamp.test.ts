import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OPENBOT_MARKER } from "../domain/types.ts";
import { PAYLOAD_FINGERPRINT_FILES, payloadFingerprint } from "../host/payload-fingerprint.ts";
import { extractPayloadFingerprint, refreshPayloadStamp, stripWrap, wrapHostSource } from "../host/wrap.ts";
import { customBoxFromProvider, officialBox, parseUpstreamOrigin } from "../parse/argv.ts";
import { boxPathsFrom } from "./paths.ts";
import { type FsDeps, type ProcDeps, parseOwnedPid } from "./procs.ts";
import { reconcile } from "./reconcile.ts";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const STOCK = `function createProtoSessionProvider(client) {\n  return { getSession: function () { return 1; } };\n}\n`;

const FP = "0123456789abcdef";

test("the payload fingerprint covers every payload CJS module", () => {
  // turn-lease.cjs runs inside the host (required by hop-handler), so a change
  // to it must move the stamp and bounce the stale host like any other module.
  assert.equal(PAYLOAD_FINGERPRINT_FILES.includes("turn-lease.cjs"), true);
  const listed: readonly string[] = PAYLOAD_FINGERPRINT_FILES;
  const dir = path.join(repoRoot, "payload");
  const modules = readdirSync(dir).filter((name) => name.endsWith(".cjs"));
  for (const name of modules) {
    assert.equal(listed.includes(name), true, `${name} must be fingerprinted`);
  }
});

test("payloadFingerprint is stable and content-sensitive", () => {
  const read = (files: Record<string, string>) => (path: string) => files[path];
  const dir = "/repo/payload";
  const a = payloadFingerprint({ payloadDir: dir, read: read({}) });
  const b = payloadFingerprint({ payloadDir: dir, read: read({}) });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  const changed = payloadFingerprint({
    payloadDir: dir,
    read: read({ [`${dir}/runtime.cjs`]: "v2" }),
  });
  assert.notEqual(changed, a);
});

test("wrap embeds the payload stamp when a fingerprint is provided", () => {
  const proof = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs", payloadFingerprint: FP });
  assert.equal(proof.kind, "wrapped");
  if (proof.kind !== "wrapped") return;
  assert.equal(proof.source.includes(OPENBOT_MARKER), true);
  assert.equal(proof.source.includes(`/* openbot-payload ${FP} */`), true);
  assert.equal(extractPayloadFingerprint(proof.source), FP);
});

test("wrap without a fingerprint keeps the legacy header", () => {
  const proof = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(proof.kind, "wrapped");
  if (proof.kind !== "wrapped") return;
  assert.equal(proof.source.includes("openbot-payload"), false);
  assert.equal(extractPayloadFingerprint(proof.source), undefined);
});

test("stripWrap removes a stamped header back to stock", () => {
  const proof = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs", payloadFingerprint: FP });
  assert.equal(proof.kind, "wrapped");
  if (proof.kind !== "wrapped") return;
  assert.equal(stripWrap(proof.source), STOCK);
});

test("refreshPayloadStamp inserts, replaces, and keeps stamps", () => {
  const legacy = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(legacy.kind, "wrapped");
  if (legacy.kind !== "wrapped") return;
  const inserted = refreshPayloadStamp(legacy.source, FP);
  assert.equal(inserted.changed, true);
  assert.equal(extractPayloadFingerprint(inserted.source), FP);
  assert.equal(inserted.source.includes(OPENBOT_MARKER), true);
  const kept = refreshPayloadStamp(inserted.source, FP);
  assert.equal(kept.changed, false);
  assert.equal(kept.source, inserted.source);
  const replaced = refreshPayloadStamp(inserted.source, "ffffffffffffffff");
  assert.equal(replaced.changed, true);
  assert.equal(extractPayloadFingerprint(replaced.source), "ffffffffffffffff");
  assert.equal(refreshPayloadStamp(STOCK, FP).changed, false);
});

type FakeProcs = ProcDeps & { stopped: number[]; termed: number[] };

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

function fakeProcs(guardPid: number | undefined): FakeProcs {
  const stopped: number[] = [];
  const termed: number[] = [];
  let guard: number | undefined = guardPid;
  let up = false;
  const procs: FakeProcs = {
    stopped,
    termed,
    async port() {
      return up;
    },
    readPidFile(path) {
      if (String(path).endsWith("openbot-guard.pid")) return guard;
      return undefined;
    },
    pidAlive(pid) {
      return pid === guard;
    },
    start(input) {
      void input;
      up = true;
      return parseOwnedPid(43);
    },
    stop(pid) {
      stopped.push(pid);
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
    syntaxCheck() {
      return { ok: true };
    },
  };
  return procs;
}

function setup(hostSource: string, guardPid: number | undefined) {
  const paths = boxPathsFrom({
    repoRoot: "/tmp/openbot-test-repo",
    sandData: "/tmp/openbot-test-data",
    hostMain: "/tmp/openbot-test-host/host-main.cjs",
  });
  const init: Record<string, string> = { [paths.hostMain]: hostSource };
  if (guardPid !== undefined) init[paths.guardPid] = `${guardPid}\n`;
  const fs = memoryFs(init);
  const procs = fakeProcs(guardPid);
  return { deps: { paths, fs, procs }, fs, procs, paths };
}

function currentFp(ctx: ReturnType<typeof setup>): string {
  return payloadFingerprint({
    payloadDir: "/tmp/openbot-test-repo/payload",
    read: (path) => ctx.fs.files[path],
  });
}

function zhipu(paths: ReturnType<typeof setup>["paths"]) {
  return customBoxFromProvider({
    paths,
    origin: parseUpstreamOrigin("https://open.bigmodel.cn/api/paas/v4"),
    name: "Zhipu",
    modelSlug: "glm-5.3-flash",
  });
}

function legacyWrapped(): string {
  const proof = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(proof.kind, "wrapped");
  if (proof.kind !== "wrapped") throw new Error("wrap failed in fixture");
  return proof.source;
}

test("reconcile restamps a legacy-marked host and bounces host + guard", async () => {
  const ctx = setup(legacyWrapped(), 77);
  const result = await reconcile(zhipu(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  const written = ctx.fs.read(ctx.paths.hostMain);
  assert.equal(extractPayloadFingerprint(written ?? ""), currentFp(ctx));
  assert.equal(ctx.procs.termed.includes(99), true);
  assert.equal(ctx.procs.stopped.includes(77), true);
  assert.equal(ctx.fs.exists(ctx.paths.guardPid), false);
});

test("reconcile leaves a current-stamped host alone", async () => {
  const ctx = setup(legacyWrapped(), 77);
  const fp = currentFp(ctx);
  const proof = wrapHostSource({ source: STOCK, runtimePath: ctx.paths.runtime as string, payloadFingerprint: fp });
  assert.equal(proof.kind, "wrapped");
  if (proof.kind !== "wrapped") return;
  ctx.fs.write(ctx.paths.hostMain, proof.source);
  const result = await reconcile(zhipu(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  assert.equal(ctx.fs.read(ctx.paths.hostMain), proof.source);
  assert.equal(ctx.procs.termed.length, 0);
  assert.equal(ctx.procs.stopped.length, 0);
  assert.equal(ctx.fs.exists(ctx.paths.guardPid), true);
});

test("official with logging on restamps a legacy-marked host", async () => {
  const ctx = setup(legacyWrapped(), undefined);
  ctx.fs.write(ctx.paths.logsSettings, JSON.stringify({ loggingEnabled: true }));
  const result = await reconcile(officialBox(ctx.paths), ctx.deps);
  assert.equal(result.kind, "ok");
  assert.equal(extractPayloadFingerprint(ctx.fs.read(ctx.paths.hostMain) ?? ""), currentFp(ctx));
  assert.equal(ctx.procs.termed.includes(99), true);
});
