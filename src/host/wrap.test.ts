import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { peelOpengrokToStock, proveWrap, stripOpengrokWrap, stripWrap, wrapHostSource } from "./wrap.ts";
import { OPENBOT_MARKER, OPENGROK_MARKER } from "../domain/types.ts";

const STOCK = `function createProtoSessionProvider(client) {
  return { getSession: function () { return 1; } };
}
`;

const STOCK_0_30_CALLSITE = `function createProtoSessionProvider(client, requestedModel, modelConfig, inferenceReason) {
  return new ProtoSessionProvider(client, requestedModel, modelConfig, inferenceReason);
}
function outer(options2) {
  const client = createSandCursorBackendClient(InferenceService, options2);
  return createProtoSessionProvider(
    client,
    options2.requestedModel,
    void 0,
    options2.inferenceReason
  ).getSession(imageResizingMiddleware);
}
`;

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

test("wrap prepends the marker and renames the stock factory", () => {
  const proof = wrapHostSource({ source: STOCK, runtimePath: "/home/box/sand-data/openbot/payload/runtime.cjs" });
  assert.equal(proof.kind, "wrapped");
  if (proof.kind !== "wrapped") {
    return;
  }
  assert.equal(proof.source.includes(OPENBOT_MARKER), true);
  assert.equal(proof.source.includes("function createProtoSessionProvider_stock("), true);
  assert.equal(proof.source.includes("wrapSession(createProtoSessionProvider_stock, arguments)"), true);
  assert.equal(proof.source.includes("async function createProtoSessionProvider"), false);
});

test("wrap is idempotent when the marker is already present", () => {
  const first = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(first.kind, "wrapped");
  if (first.kind !== "wrapped") {
    return;
  }
  const second = wrapHostSource({ source: first.source, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(second.kind, "already-marked");
});

test("proveWrap is the copy transform, not a file write", () => {
  const proof = proveWrap({ source: STOCK, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(proof.kind, "wrapped");
  assert.equal(STOCK.includes(OPENBOT_MARKER), false);
});

test("stripWrap restores the factory name", () => {
  const proof = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(proof.kind, "wrapped");
  if (proof.kind !== "wrapped") {
    return;
  }
  const stripped = stripWrap(proof.source);
  assert.equal(stripped.includes(OPENBOT_MARKER), false);
  assert.equal(stripped.includes("createProtoSessionProvider_stock"), false);
  assert.equal(stripped.includes("function createProtoSessionProvider("), true);
});

test("stripOpengrokWrap restores the stock factory", () => {
  const wrapped = opengrokWrap(STOCK);
  const stripped = stripOpengrokWrap(wrapped);
  assert.equal(stripped.includes(OPENGROK_MARKER), false);
  assert.equal(stripped.includes("createProtoSessionProvider_stock"), false);
  assert.equal(stripped, STOCK);
  const peeled = peelOpengrokToStock(wrapped);
  assert.equal(peeled.kind, "stock");
  if (peeled.kind === "stock") {
    assert.equal(peeled.source, STOCK);
  }
});

test("private-lane wrap is refused", () => {
  const src = STOCK + "createOpenAiHopSession();\nresolvedOpenaiBaseUrl();\n";
  const proof = wrapHostSource({ source: src, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(proof.kind, "refused");
});

test("opengrok wrap is refused without peeling", () => {
  const proof = wrapHostSource({
    source: opengrokWrap(STOCK),
    runtimePath: "/tmp/runtime.cjs",
  });
  assert.equal(proof.kind, "refused");
});

test("wrapped source passes node --check when the temp file ends in .cjs", () => {
  const proof = wrapHostSource({ source: STOCK, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(proof.kind, "wrapped");
  if (proof.kind !== "wrapped") {
    return;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-check-"));
  const file = path.join(dir, "host-main.openbot-check.cjs");
  writeFileSync(file, proof.source);
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
});

test("stock 0.30 callsite wraps and still parses as CommonJS", () => {
  const proof = wrapHostSource({ source: STOCK_0_30_CALLSITE, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(proof.kind, "wrapped");
  if (proof.kind !== "wrapped") {
    return;
  }
  assert.equal(proof.source.includes("function createProtoSessionProvider_stock("), true);
  assert.equal(proof.source.includes(".getSession(imageResizingMiddleware)"), true);
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-0.30-"));
  const file = path.join(dir, "host-main.openbot-check.cjs");
  writeFileSync(file, proof.source);
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
});
