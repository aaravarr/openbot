import assert from "node:assert/strict";
import test from "node:test";
import { type Catalog, type SecretBytes } from "../domain/types.ts";
import { type SecretStore } from "../supervisor/secrets.ts";
import { fetchModelsForProvider, modelsUrl, normalizeProviderModels, type FetchLike } from "./provider-models.ts";

type ResponseStub = { readonly status: number; readonly ok: boolean; text(): Promise<string> };

function jsonResponse(status: number, body: unknown): ResponseStub {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

function textResponse(status: number, text: string): ResponseStub {
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

function makeCatalog(providers: { id: string; name: string; origin: string }[]): Catalog {
  const catalog = {
    providers: providers.map((provider) => ({
      ...provider,
      maxTokensDefault: 65536,
      mapFile: "provider-maps.cjs",
    })),
    models: [],
    bindings: [],
  };
  return catalog as unknown as Catalog;
}

function makeSecrets(entries: Record<string, string>): SecretStore {
  const providers: { [id: string]: SecretBytes } = {};
  for (const [id, value] of Object.entries(entries)) {
    providers[id] = value as SecretBytes;
  }
  return { providers };
}

test("modelsUrl reuses the hop base-URL normalization", () => {
  assert.equal(modelsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/models");
  assert.equal(modelsUrl("https://open.bigmodel.cn/api/paas/v4"), "https://open.bigmodel.cn/api/paas/v4/models");
  assert.equal(modelsUrl("https://example.com/v4"), "https://example.com/v4/models");
  assert.equal(modelsUrl("https://example.com/chat/completions"), "https://example.com/chat/completions/models");
  assert.equal(modelsUrl("https://example.com"), "https://example.com/v1/models");
  assert.equal(modelsUrl("https://example.com/"), "https://example.com/v1/models");
});

test("normalizeProviderModels rejects a body that is not a model list", () => {
  assert.equal(normalizeProviderModels({ foo: 1 }), undefined);
  assert.equal(normalizeProviderModels([]), undefined);
  assert.equal(normalizeProviderModels("nope"), undefined);
});

test("normalizeProviderModels drops entries without an id as skipped", () => {
  const result = normalizeProviderModels({
    data: [
      { id: "glm-5.3", name: "GLM 5.3" },
      { name: "no id" },
      "not an object",
      { id: "glm-5.3" },
    ],
  });
  assert.ok(result);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0]?.id, "glm-5.3");
  assert.equal(result.skipped, 3);
  assert.deepEqual(result.skippedReasons, ["missing-id", "not-an-object", "duplicate-id"]);
});

test("normalizeProviderModels maps modalities and reasoning levels to the allowed sets", () => {
  const result = normalizeProviderModels({
    data: [
      {
        id: "m",
        input_modalities: ["text", "image", "weird"],
        reasoningLevels: ["high", "low", "bogus", "high"],
      },
    ],
  });
  assert.ok(result);
  const model = result.models[0];
  assert.ok(model);
  assert.deepEqual(model.modalities, ["text", "image"]);
  assert.deepEqual(model.reasoningLevels, ["default", "none", "low", "high"]);
});

test("normalizeProviderModels reads nested reasoning.supported_efforts", () => {
  const result = normalizeProviderModels({
    data: [
      {
        id: "deepseek-v4-flash",
        reasoning: { mandatory: false, supported_efforts: ["xhigh", "high"] },
      },
    ],
  });
  assert.ok(result);
  assert.deepEqual(result.models[0]?.reasoningLevels, ["default", "none", "high", "xhigh"]);
});

test("normalizeProviderModels reads nested reasoning_options", () => {
  const result = normalizeProviderModels({
    data: [
      {
        id: "glm-5.3-flash",
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["low", "high", "max"] },
        ],
      },
    ],
  });
  assert.ok(result);
  assert.deepEqual(result.models[0]?.reasoningLevels, ["default", "none", "low", "high", "max"]);
});

test("fetch-models succeeds and forwards the stored secret server-side", async () => {
  const catalog = makeCatalog([{ id: "zhipu", name: "Zhipu", origin: "https://open.bigmodel.cn/api/paas/v4" }]);
  const store = makeSecrets({ zhipu: "sk-live" });
  let requestedUrl = "";
  let requestedAuth = "";
  const fetchFn: FetchLike = async (url, init) => {
    requestedUrl = url;
    requestedAuth = init?.headers?.Authorization ?? "";
    return jsonResponse(200, {
      data: [
        { id: "glm-5.3", name: "GLM 5.3", context_length: 128000 },
        { id: "glm-4.5" },
        { name: "missing id" },
      ],
    });
  };
  const result = await fetchModelsForProvider({ providerId: "zhipu", catalog, secretStore: store, fetchFn });
  assert.equal(result.status, 200);
  assert.equal(requestedUrl, "https://open.bigmodel.cn/api/paas/v4/models");
  assert.equal(requestedAuth, "Bearer sk-live");
  const body = result.body as {
    ok: boolean;
    providerId: string;
    source: string;
    skipped: number;
    skippedReasons: string[];
    models: { id: string; name: string | null; contextLength: number | null; modalities: string[] }[];
  };
  assert.equal(body.ok, true);
  assert.equal(body.providerId, "zhipu");
  assert.equal(body.source, "provider");
  assert.equal(body.skipped, 1);
  assert.deepEqual(body.skippedReasons, ["missing-id"]);
  assert.equal(body.models.length, 2);
  assert.equal(body.models[0]?.id, "glm-5.3");
  assert.equal(body.models[0]?.contextLength, 128000);
  assert.equal(body.models[0]?.modalities.length, 0);
});

test("fetch-models returns 404 provider-not-found", async () => {
  const result = await fetchModelsForProvider({
    providerId: "missing",
    catalog: makeCatalog([{ id: "zhipu", name: "Zhipu", origin: "https://example.com/v1" }]),
    secretStore: makeSecrets({}),
  });
  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { error: { kind: "provider-not-found", message: "provider not found" } });
});

test("fetch-models returns 409 no-secret when the provider has no key", async () => {
  const result = await fetchModelsForProvider({
    providerId: "zhipu",
    catalog: makeCatalog([{ id: "zhipu", name: "Zhipu", origin: "https://example.com/v1" }]),
    secretStore: makeSecrets({}),
  });
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: { kind: "no-secret", message: "no API key stored for this provider" } });
});

test("fetch-models maps upstream 401 to unauthorized", async () => {
  const fetchFn: FetchLike = async () => jsonResponse(401, { error: { message: "bad key" } });
  const result = await fetchModelsForProvider({
    providerId: "zhipu",
    catalog: makeCatalog([{ id: "zhipu", name: "Zhipu", origin: "https://example.com/v1" }]),
    secretStore: makeSecrets({ zhipu: "sk-live" }),
    fetchFn,
  });
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, {
    error: { kind: "unauthorized", message: "provider rejected the API key", upstreamStatus: 401 },
  });
});

test("fetch-models maps upstream 404 to not-supported", async () => {
  const fetchFn: FetchLike = async () => jsonResponse(404, {});
  const result = await fetchModelsForProvider({
    providerId: "zhipu",
    catalog: makeCatalog([{ id: "zhipu", name: "Zhipu", origin: "https://example.com/v1" }]),
    secretStore: makeSecrets({ zhipu: "sk-live" }),
    fetchFn,
  });
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, {
    error: { kind: "not-supported", message: "provider does not expose a model list", upstreamStatus: 404 },
  });
});

test("fetch-models maps a network failure to unreachable without upstreamStatus", async () => {
  const fetchFn: FetchLike = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const result = await fetchModelsForProvider({
    providerId: "zhipu",
    catalog: makeCatalog([{ id: "zhipu", name: "Zhipu", origin: "https://example.com/v1" }]),
    secretStore: makeSecrets({ zhipu: "sk-live" }),
    fetchFn,
  });
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { error: { kind: "unreachable", message: "provider is unreachable" } });
});

test("fetch-models maps an upstream 503 to unreachable with upstreamStatus", async () => {
  const fetchFn: FetchLike = async () => jsonResponse(503, {});
  const result = await fetchModelsForProvider({
    providerId: "zhipu",
    catalog: makeCatalog([{ id: "zhipu", name: "Zhipu", origin: "https://example.com/v1" }]),
    secretStore: makeSecrets({ zhipu: "sk-live" }),
    fetchFn,
  });
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, {
    error: { kind: "unreachable", message: "upstream returned HTTP 503", upstreamStatus: 503 },
  });
});

test("fetch-models maps a 200 non-list body to parse-error", async () => {
  const fetchFn: FetchLike = async () => jsonResponse(200, { something: "else" });
  const result = await fetchModelsForProvider({
    providerId: "zhipu",
    catalog: makeCatalog([{ id: "zhipu", name: "Zhipu", origin: "https://example.com/v1" }]),
    secretStore: makeSecrets({ zhipu: "sk-live" }),
    fetchFn,
  });
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { error: { kind: "parse-error", message: "provider response is not a model list" } });
});

test("fetch-models maps a 200 non-JSON body to parse-error", async () => {
  const fetchFn: FetchLike = async () => textResponse(200, "<html>not json</html>");
  const result = await fetchModelsForProvider({
    providerId: "zhipu",
    catalog: makeCatalog([{ id: "zhipu", name: "Zhipu", origin: "https://example.com/v1" }]),
    secretStore: makeSecrets({ zhipu: "sk-live" }),
    fetchFn,
  });
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { error: { kind: "parse-error", message: "provider returned a non-JSON body" } });
});

test("fetch-models maps an unexpected failure to 500 internal", async () => {
  const result = await fetchModelsForProvider({
    providerId: "zhipu",
    catalog: makeCatalog([{ id: "zhipu", name: "Zhipu", origin: "" }]),
    secretStore: makeSecrets({ zhipu: "sk-live" }),
  });
  assert.equal(result.status, 500);
  const body = result.body as { error: { kind: string } };
  assert.equal(body.error.kind, "internal");
});
