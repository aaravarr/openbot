import assert from "node:assert/strict";
import test from "node:test";
import { proveWrap, stripWrap, wrapHostSource } from "./wrap.ts";
import { OPENBOT_MARKER } from "../domain/types.ts";

const STOCK = `function createProtoSessionProvider(client) {
  return { getSession: function () { return 1; } };
}
`;

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

test("private-lane wrap is refused", () => {
  const src = STOCK + "createOpenAiHopSession();\nresolvedOpenaiBaseUrl();\n";
  const proof = wrapHostSource({ source: src, runtimePath: "/tmp/runtime.cjs" });
  assert.equal(proof.kind, "refused");
});

test("opengrok wrap is refused", () => {
  const proof = wrapHostSource({
    source: "/* opengrok-stock-wrap */\n" + STOCK,
    runtimePath: "/tmp/runtime.cjs",
  });
  assert.equal(proof.kind, "refused");
});
