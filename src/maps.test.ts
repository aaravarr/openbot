import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const mapsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../payload/provider-maps.cjs");
const maps = require(mapsPath) as {
  applyProviderReasoningControls: (
    body: Record<string, unknown>,
    ctx: { modelId: string; baseUrl: string; parameters: readonly { id: string; value: string }[] },
  ) => string;
};

test("GLM maps do not default to fast true", () => {
  const body: Record<string, unknown> = { model: "glm-5.3-flash" };
  const result = maps.applyProviderReasoningControls(body, {
    modelId: "glm-5.3-flash",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    parameters: [],
  });
  assert.equal(result, "glm-passthrough");
  assert.equal(body.thinking, undefined);
});

test("GLM fast is opt-in through a model parameter, not an installer default", () => {
  const body: Record<string, unknown> = { model: "glm-5.3-flash" };
  const result = maps.applyProviderReasoningControls(body, {
    modelId: "glm-5.3-flash",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    parameters: [{ id: "fast", value: "true" }],
  });
  assert.equal(result, "glm-fast-off");
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("GLM effort enables thinking and sets reasoning_effort", () => {
  const body: Record<string, unknown> = { model: "glm-4.6" };
  const result = maps.applyProviderReasoningControls(body, {
    modelId: "glm-4.6",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    parameters: [{ id: "effort", value: "high" }],
  });
  assert.equal(result, "glm-effort");
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "high");
});

test("GLM thinking=false sets thinking disabled", () => {
  const body: Record<string, unknown> = { model: "glm-5.3-flash" };
  const result = maps.applyProviderReasoningControls(body, {
    modelId: "glm-5.3-flash",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    parameters: [{ id: "thinking", value: "false" }],
  });
  assert.equal(result, "glm-thinking-off");
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("Grok effort maps max to xhigh", () => {
  const body: Record<string, unknown> = { model: "grok-3" };
  const result = maps.applyProviderReasoningControls(body, {
    modelId: "grok-3",
    baseUrl: "https://api.x.ai/v1",
    parameters: [{ id: "effort", value: "max" }],
  });
  assert.equal(result, "grok-effort");
  assert.equal(body.reasoning_effort, "xhigh");
});

test("Grok thinking=false is passthrough without a disable field", () => {
  const body: Record<string, unknown> = { model: "grok-3" };
  const result = maps.applyProviderReasoningControls(body, {
    modelId: "grok-3",
    baseUrl: "https://api.x.ai/v1",
    parameters: [{ id: "thinking", value: "false" }],
  });
  assert.equal(result, "grok-thinking-off");
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, undefined);
});

test("generic OpenAI maps effort to reasoning_effort", () => {
  const body: Record<string, unknown> = { model: "gpt-4.1" };
  const result = maps.applyProviderReasoningControls(body, {
    modelId: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
    parameters: [{ id: "effort", value: "high" }],
  });
  assert.equal(result, "openai-effort");
  assert.equal(body.reasoning_effort, "high");
});

test("generic OpenAI does not set reasoning_effort without effort", () => {
  const body: Record<string, unknown> = { model: "gpt-4.1" };
  const result = maps.applyProviderReasoningControls(body, {
    modelId: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
    parameters: [],
  });
  assert.equal(result, "none");
  assert.equal(body.reasoning_effort, undefined);
});

test("generic OpenAI thinking=false sets thinking disabled", () => {
  const body: Record<string, unknown> = { model: "gpt-4.1" };
  const result = maps.applyProviderReasoningControls(body, {
    modelId: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
    parameters: [{ id: "thinking", value: "false" }],
  });
  assert.equal(result, "openai-thinking-off");
  assert.deepEqual(body.thinking, { type: "disabled" });
});
