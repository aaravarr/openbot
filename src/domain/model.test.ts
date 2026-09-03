import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODALITIES,
  DEFAULT_REASONING_LEVELS,
  hasSelectableReasoning,
  keepReasoningOrder,
  makeModel,
  normalizeModel,
  parseModalities,
  parsePositiveTokens,
  parseReasoningLevels,
  pickActiveReasoning,
  REASONING_LEVELS,
} from "./model.ts";
import { HIGH_AGENT_MAX_TOKENS, type ModelId, type ProviderId } from "./types.ts";
import { parseModelSlug } from "../supervisor/plan.ts";

function sample(overrides: Record<string, unknown> = {}) {
  return makeModel({
    id: "zhipu:glm-4.6" as ModelId,
    providerId: "zhipu" as ProviderId,
    slug: parseModelSlug("glm-4.6"),
    ...overrides,
  });
}

test("makeModel fills default context, output, reasoning, and text-only modalities", () => {
  const model = sample();
  assert.equal(model.contextTokens, DEFAULT_CONTEXT_TOKENS);
  assert.equal(model.maxOutputTokens, HIGH_AGENT_MAX_TOKENS);
  assert.deepEqual(model.reasoningLevels, DEFAULT_REASONING_LEVELS);
  assert.equal(model.activeReasoning, "default");
  assert.deepEqual(model.modalities, DEFAULT_MODALITIES);
});

test("empty reasoning and modality lists fall back to defaults", () => {
  assert.deepEqual(parseReasoningLevels([]), DEFAULT_REASONING_LEVELS);
  assert.deepEqual(parseModalities(""), DEFAULT_MODALITIES);
  const model = sample({ reasoningLevels: [], modalities: [] });
  assert.deepEqual(model.reasoningLevels, DEFAULT_REASONING_LEVELS);
  assert.deepEqual(model.modalities, DEFAULT_MODALITIES);
});

test("parseReasoningLevels prepends default on old catalogs", () => {
  assert.deepEqual(parseReasoningLevels(["none", "low", "high"]), ["default", "none", "low", "high"]);
});

test("REASONING_LEVELS places xhigh one step below max", () => {
  assert.deepEqual(
    [...REASONING_LEVELS],
    ["default", "none", "low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    keepReasoningOrder(new Set(["max", "xhigh", "high", "default"])),
    ["default", "high", "xhigh", "max"],
  );
  assert.deepEqual(parseReasoningLevels(["max", "xhigh", "high"]), ["default", "high", "xhigh", "max"]);
});

test("parsePositiveTokens rejects zero, negative, and oversized values", () => {
  assert.equal(parsePositiveTokens(0, 128000), 128000);
  assert.equal(parsePositiveTokens(-1, 128000), 128000);
  assert.equal(parsePositiveTokens(20_000_000, 128000), 128000);
  assert.equal(parsePositiveTokens(4096, 128000), 4096);
});

test("pickActiveReasoning stays on the supported list", () => {
  assert.equal(pickActiveReasoning(["none", "low", "high"], "high"), "high");
  assert.equal(pickActiveReasoning(["none", "low", "high"], "xhigh"), "none");
  assert.equal(pickActiveReasoning(["low", "high"], "none"), "low");
  assert.equal(pickActiveReasoning(["default", "none", "low", "high"], "xhigh"), "default");
  assert.equal(pickActiveReasoning(["default", "none", "low", "high"], "none"), "none");
});

test("old catalog none migrates to default; new none stays Off", () => {
  assert.equal(
    pickActiveReasoning(["default", "none", "low", "high"], "none", ["none", "low", "high"]),
    "default",
  );
  assert.equal(
    pickActiveReasoning(["default", "none", "low", "high"], "none", ["default", "none", "low", "high"]),
    "none",
  );
  const migrated = sample({ reasoningLevels: ["none", "low", "high"], activeReasoning: "none" });
  assert.equal(migrated.activeReasoning, "default");
  const explicit = sample({
    reasoningLevels: ["default", "none", "low", "high"],
    activeReasoning: "none",
  });
  assert.equal(explicit.activeReasoning, "none");
});

test("normalizeModel upgrades a catalog row that predates limits", () => {
  const model = normalizeModel({
    id: "openai:gpt-4.1",
    providerId: "openai",
    slug: "gpt-4.1",
    parameters: [],
  });
  assert.ok(model);
  assert.equal(model.contextTokens, DEFAULT_CONTEXT_TOKENS);
  assert.equal(model.maxOutputTokens, HIGH_AGENT_MAX_TOKENS);
  assert.equal(model.activeReasoning, "default");
  assert.deepEqual(model.modalities, ["text"]);
});

test("hasSelectableReasoning is false when only default is listed", () => {
  assert.equal(hasSelectableReasoning({ reasoningLevels: ["default"] }), false);
  assert.equal(hasSelectableReasoning({ reasoningLevels: ["none"] }), true);
  assert.equal(hasSelectableReasoning({ reasoningLevels: ["default", "none"] }), true);
});
