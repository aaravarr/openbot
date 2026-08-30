import assert from "node:assert/strict";
import test from "node:test";
import { censusHost, countLiteral, hasForeignOpengrokWrap } from "./census.ts";

const STOCK = `
function helper() { return 1; }
function createProtoSessionProvider(client, requestedModel, modelConfig, inferenceReason) {
  return { getSession: function () { return {}; } };
}
`;

test("stock census requires the unique Provider factory and ignores the createProtoSession trap", () => {
  const census = censusHost(STOCK);
  assert.equal(census.kind, "stock");
  assert.equal(countLiteral(STOCK, "function createProtoSession("), 0);
  assert.equal(countLiteral(STOCK, "createProtoSession") > 0, true);
});

test("already-openbot wins over a second factory look", () => {
  const src = "/* openbot-stock-wrap */\n" + STOCK.replace(
    "function createProtoSessionProvider(",
    "function createProtoSessionProvider_stock(",
  );
  assert.equal(censusHost(src).kind, "already-openbot");
});

test("private-lane is both hop symbols", () => {
  const src = STOCK + "\ncreateOpenAiHopSession();\nresolvedOpenaiBaseUrl();\n";
  const census = censusHost(src);
  assert.equal(census.kind, "private-lane");
});

test("gap is exactly one hop symbol", () => {
  const src = STOCK + "\ncreateOpenAiHopSession();\n";
  const census = censusHost(src);
  assert.equal(census.kind, "gap");
  if (census.kind === "gap") {
    assert.equal(census.present, "createOpenAiHopSession");
    assert.equal(census.missing, "resolvedOpenaiBaseUrl");
  }
});

test("two factory defs are ambiguous", () => {
  const src = STOCK + STOCK;
  assert.equal(censusHost(src).kind, "ambiguous-factory");
});

test("async factory is not stock", () => {
  const src = STOCK.replace("function createProtoSessionProvider(", "async function createProtoSessionProvider(");
  assert.equal(censusHost(src).kind, "ambiguous-factory");
});

test("opengrok marker is foreign", () => {
  assert.equal(hasForeignOpengrokWrap("/* opengrok-stock-wrap */\n" + STOCK), true);
});
