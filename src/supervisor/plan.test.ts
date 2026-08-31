import assert from "node:assert/strict";
import test from "node:test";
import { catalogFromPlanJson } from "./plan.ts";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_REASONING_LEVELS } from "../domain/model.ts";
import { HIGH_AGENT_MAX_TOKENS } from "../domain/types.ts";

test("catalogFromPlanJson fills model limits on old plan JSON", () => {
  const catalog = catalogFromPlanJson(
    JSON.stringify({
      kind: "custom",
      catalog: {
        providers: [
          {
            id: "zhipu",
            name: "Zhipu",
            origin: "https://open.bigmodel.cn/api/paas/v4",
            maxTokensDefault: 65536,
            mapFile: "provider-maps.cjs",
          },
        ],
        models: [{ id: "zhipu:glm", providerId: "zhipu", slug: "glm-5.3-flash", parameters: [] }],
        bindings: [{ conversation: { kind: "wildcard" }, modelId: "zhipu:glm" }],
      },
    }),
  );
  const model = catalog.models[0];
  assert.ok(model);
  assert.equal(model.contextTokens, DEFAULT_CONTEXT_TOKENS);
  assert.equal(model.maxOutputTokens, HIGH_AGENT_MAX_TOKENS);
  assert.deepEqual(model.reasoningLevels, DEFAULT_REASONING_LEVELS);
  assert.equal(model.activeReasoning, "none");
  assert.deepEqual(model.modalities, ["text"]);
});

test("catalogFromPlanJson keeps configured context, output, reasoning, and modalities", () => {
  const catalog = catalogFromPlanJson(
    JSON.stringify({
      kind: "custom",
      catalog: {
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            origin: "https://api.openai.com/v1",
            maxTokensDefault: 65536,
            mapFile: "provider-maps.cjs",
          },
        ],
        models: [
          {
            id: "openai:gpt-4.1",
            providerId: "openai",
            slug: "gpt-4.1",
            contextTokens: 200000,
            maxOutputTokens: 8192,
            reasoningLevels: ["none", "low", "high"],
            activeReasoning: "high",
            modalities: ["text", "image"],
            parameters: [],
          },
        ],
        bindings: [],
      },
    }),
  );
  const model = catalog.models[0];
  assert.ok(model);
  assert.equal(model.contextTokens, 200000);
  assert.equal(model.maxOutputTokens, 8192);
  assert.deepEqual(model.reasoningLevels, ["none", "low", "high"]);
  assert.equal(model.activeReasoning, "high");
  assert.deepEqual(model.modalities, ["text", "image"]);
});
