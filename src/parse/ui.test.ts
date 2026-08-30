import assert from "node:assert/strict";
import test from "node:test";
import { parseUiProviderSave } from "./ui.ts";
import { boxPathsFrom } from "../supervisor/paths.ts";
import { parseUpstreamOrigin } from "./argv.ts";
import { HIGH_AGENT_MAX_TOKENS, type Catalog } from "../domain/types.ts";
import { parseModelId, parseModelSlug } from "../supervisor/plan.ts";
import { parseProviderId } from "../supervisor/secrets.ts";

function paths() {
  return boxPathsFrom({ repoRoot: "/tmp/openbot", sandData: "/tmp/openbot-data" });
}

function zhipuCatalog(): Catalog {
  const providerId = parseProviderId("zhipu");
  const modelId = parseModelId("zhipu:glm-5.3-flash");
  return {
    providers: [
      {
        id: providerId,
        name: "Zhipu",
        origin: parseUpstreamOrigin("https://open.bigmodel.cn/api/paas/v4"),
        maxTokensDefault: HIGH_AGENT_MAX_TOKENS,
        mapFile: "provider-maps.cjs",
      },
    ],
    models: [{ id: modelId, providerId, slug: parseModelSlug("glm-5.3-flash"), parameters: [] }],
    bindings: [{ conversation: { kind: "wildcard" }, modelId }],
  };
}

function twoProviderCatalog(): Catalog {
  const catalog = zhipuCatalog();
  const openaiId = parseProviderId("openai");
  const gpt = parseModelId("openai:gpt-4.1");
  return {
    providers: [
      ...catalog.providers,
      {
        id: openaiId,
        name: "OpenAI",
        origin: parseUpstreamOrigin("https://api.openai.com/v1"),
        maxTokensDefault: HIGH_AGENT_MAX_TOKENS,
        mapFile: "provider-maps.cjs",
      },
    ],
    models: [...catalog.models, { id: gpt, providerId: openaiId, slug: parseModelSlug("gpt-4.1"), parameters: [] }],
    bindings: catalog.bindings,
  };
}

test("UI custom save keeps the secret off DesiredState", () => {
  const parsed = parseUiProviderSave(
    {
      kind: "custom",
      name: "Zhipu",
      origin: "https://open.bigmodel.cn/api/paas/v4",
      modelSlug: "glm-5.3-flash",
      secret: "sk-live",
    },
    paths(),
  );
  assert.equal(parsed.desired.kind, "custom");
  assert.equal("secret" in parsed.desired, false);
  if (parsed.desired.kind === "custom") {
    const binding = parsed.desired.catalog.bindings[0];
    assert.ok(binding);
    assert.equal("apiKey" in binding, false);
    assert.equal("hopBaseUrl" in binding, false);
  }
  assert.equal(parsed.secret?.bytes, "sk-live");
});

test("upsert-provider keeps an existing origin in the catalog", () => {
  const parsed = parseUiProviderSave(
    {
      kind: "upsert-provider",
      name: "OpenAI",
      origin: "https://api.openai.com/v1",
      modelSlug: "gpt-4.1",
      secret: "sk-openai",
    },
    paths(),
    zhipuCatalog(),
  );
  assert.equal(parsed.desired.kind, "custom");
  if (parsed.desired.kind !== "custom") {
    return;
  }
  assert.equal(parsed.desired.catalog.providers.length, 2);
  assert.equal(parsed.desired.catalog.models.length, 2);
  const used = parsed.desired.catalog.bindings[0];
  assert.equal(used?.modelId, "openai:gpt-4.1");
});

test("use-model switches the wildcard without dropping providers", () => {
  const parsed = parseUiProviderSave({ kind: "use-model", modelId: "openai:gpt-4.1" }, paths(), twoProviderCatalog());
  assert.equal(parsed.desired.kind, "custom");
  if (parsed.desired.kind !== "custom") {
    return;
  }
  assert.equal(parsed.desired.catalog.providers.length, 2);
  assert.equal(parsed.desired.catalog.bindings[0]?.modelId, "openai:gpt-4.1");
});

test("remove last provider becomes official", () => {
  const parsed = parseUiProviderSave({ kind: "remove-provider", providerId: "zhipu" }, paths(), zhipuCatalog());
  assert.equal(parsed.desired.kind, "official");
});

test("remove one provider keeps the other and rebinds if needed", () => {
  const parsed = parseUiProviderSave({ kind: "remove-provider", providerId: "zhipu" }, paths(), twoProviderCatalog());
  assert.equal(parsed.desired.kind, "custom");
  if (parsed.desired.kind !== "custom") {
    return;
  }
  assert.equal(parsed.desired.catalog.providers.length, 1);
  assert.equal(parsed.desired.catalog.providers[0]?.id, "openai");
  assert.equal(parsed.desired.catalog.bindings[0]?.modelId, "openai:gpt-4.1");
});

test("set-secret stays custom and never puts the key on DesiredState", () => {
  const parsed = parseUiProviderSave(
    { kind: "set-secret", providerId: "zhipu", secret: "sk-rotated" },
    paths(),
    zhipuCatalog(),
  );
  assert.equal(parsed.desired.kind, "custom");
  assert.equal(parsed.secret?.bytes, "sk-rotated");
  assert.equal("secret" in parsed.desired, false);
});
