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
