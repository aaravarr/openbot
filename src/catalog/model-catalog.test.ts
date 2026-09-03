import assert from "node:assert/strict";
import test from "node:test";
import { type AbsPath } from "../domain/types.ts";
import { createCatalogManager, type CatalogCacheFs, type FetchLike } from "./model-catalog.ts";

type ResponseStub = { readonly status: number; readonly ok: boolean; text(): Promise<string> };

function jsonResponse(status: number, body: unknown): ResponseStub {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

function memFs(): CatalogCacheFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: (path: AbsPath) => files.get(String(path)),
    write: (path: AbsPath, body: string) => {
      files.set(String(path), body);
    },
  };
}

function clock(): () => string {
  let i = 0;
  return () => `t${String(i++)}`;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const cachePath = "/cache/model-catalog.json" as AbsPath;

test("catalog manager reports loading then ready across a startup fetch", async () => {
  const fs = memFs();
  const gate = deferred<ResponseStub>();
  const fetchFn: FetchLike = async () => gate.promise;
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });

  assert.equal(manager.snapshot().status, "loading");
  assert.equal(manager.snapshot().lastFetched, null);

  const start = manager.start();
  assert.equal(manager.snapshot().status, "loading");
  gate.resolve(jsonResponse(200, { data: [{ id: "openrouter/a", name: "A" }] }));
  await start;

  const snapshot = manager.snapshot();
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.lastFetched, "t0");
  assert.equal(snapshot.totalModels, 1);
});

test("catalog manager merges both sources and dedupes by id", async () => {
  const fs = memFs();
  const fetchFn: FetchLike = async (url) => {
    if (url.includes("openrouter")) {
      return jsonResponse(200, {
        data: [
          { id: "openrouter/a", name: "A", context_length: 1000 },
          { id: "shared/model", name: "Shared (openrouter)", context_length: 2000 },
        ],
      });
    }
    return jsonResponse(200, {
      provider: {
        name: "Provider",
        models: {
          "shared/model": { id: "shared/model", name: "Shared (models.dev)", context_length: 3000 },
          "provider/b": { id: "provider/b", name: "B" },
        },
      },
    });
  };
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });
  await manager.start();

  const snapshot = manager.snapshot();
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.totalModels, 3);
  assert.deepEqual(
    snapshot.sources.map((source) => [source.name, source.modelCount]),
    [
      ["openrouter", 2],
      ["models.dev", 2],
    ],
  );
  // models.dev wins the shared id.
  const shared = manager.snapshot("shared/model").lookup;
  assert.ok(shared);
  assert.equal(shared.found, true);
  if (shared.found) {
    assert.equal(shared.model.name, "Shared (models.dev)");
    assert.equal(shared.model.contextLength, 3000);
  }
});

test("catalog lookup normalizes openrouter metadata", async () => {
  const fs = memFs();
  const fetchFn: FetchLike = async (url) => {
    if (url.includes("openrouter")) {
      return jsonResponse(200, {
        data: [
          {
            id: "deepseek/deepseek-r1",
            name: "DeepSeek: R1",
            context_length: 65536,
            architecture: { input_modalities: ["text", "image"] },
            top_provider: { max_completion_tokens: 8192 },
            pricing: { prompt: "0.00000055", completion: "0.00000219" },
            supported_parameters: ["temperature", "reasoning_effort"],
          },
        ],
      });
    }
    return jsonResponse(200, {});
  };
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });
  await manager.start();

  const result = manager.snapshot("deepseek/deepseek-r1").lookup;
  assert.ok(result);
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.model.contextLength, 65536);
    assert.equal(result.model.maxOutputTokens, 8192);
    assert.deepEqual(result.model.modalities, ["text", "image"]);
    assert.equal(result.model.reasoning, true);
    assert.ok(result.model.pricing);
    assert.equal(result.model.pricing?.input, 0.00000055);
    assert.equal(result.model.pricing?.currency, "USD");
  }
});

test("catalog lookup returns found false for an unknown model id", async () => {
  const fs = memFs();
  const fetchFn: FetchLike = async () => jsonResponse(200, { data: [{ id: "a", name: "A" }] });
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });
  await manager.start();

  const result = manager.snapshot("does-not-exist").lookup;
  assert.ok(result);
  assert.equal(result.found, false);
});

test("catalog manager fails with unreachable when there is no cached copy", async () => {
  const fs = memFs();
  const fetchFn: FetchLike = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });
  await manager.start();

  const snapshot = manager.snapshot();
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.lastFetched, null);
  assert.deepEqual(snapshot.error, { kind: "unreachable", message: "openrouter is unreachable" });
});

test("catalog manager persists the cache and reloads it when the network is down", async () => {
  const fs = memFs();
  const now = clock();
  const goodFetch: FetchLike = async (url) => {
    if (url.includes("openrouter")) {
      return jsonResponse(200, { data: [{ id: "openrouter/gpt-4o", name: "GPT-4o", context_length: 128000 }] });
    }
    return jsonResponse(200, { provider: { name: "P", models: { "provider/m": { id: "provider/m", name: "M" } } } });
  };
  const first = createCatalogManager({ fs, cachePath, fetchFn: goodFetch, now });
  await first.start();
  assert.equal(first.snapshot().totalModels, 2);
  assert.ok(fs.files.get(String(cachePath)));

  const downFetch: FetchLike = async () => {
    throw new Error("down");
  };
  const second = createCatalogManager({ fs, cachePath, fetchFn: downFetch, now });
  await second.start();

  const snapshot = second.snapshot();
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.totalModels, 2);
  assert.equal(snapshot.lastFetched, "t0");
  const lookup = second.snapshot("openrouter/gpt-4o").lookup;
  assert.ok(lookup);
  assert.equal(lookup.found, true);
  if (lookup.found) {
    assert.equal(lookup.model.contextLength, 128000);
  }
});

test("refresh transitions to loading then ready and is idempotent while in flight", async () => {
  const fs = memFs();
  const gate = deferred<ResponseStub>();
  const fetchFn: FetchLike = async () => gate.promise;
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });

  const first = manager.refresh();
  const second = manager.refresh();
  assert.equal(first.startedAt, second.startedAt);
  assert.equal(manager.snapshot().status, "loading");

  gate.resolve(jsonResponse(200, { data: [{ id: "a", name: "A" }] }));
  await first.done;

  assert.equal(manager.snapshot().status, "ready");
  assert.equal(manager.snapshot().totalModels, 1);
});

test("a failed refresh keeps the previous cache and reports ready", async () => {
  const fs = memFs();
  const now = clock();
  let down = false;
  const fetchFn: FetchLike = async (url) => {
    if (down) {
      throw new Error("down");
    }
    if (url.includes("openrouter")) {
      return jsonResponse(200, { data: [{ id: "a", name: "A" }] });
    }
    return jsonResponse(200, {});
  };
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now });
  await manager.start();
  assert.equal(manager.snapshot().lastFetched, "t0");
  assert.equal(manager.snapshot().totalModels, 1);

  down = true;
  await manager.refresh().done;

  const snapshot = manager.snapshot();
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.lastFetched, "t0");
  assert.equal(snapshot.totalModels, 1);
});

test("catalog normalizes a models.dev-only entry (real shape)", async () => {
  const fs = memFs();
  const fetchFn: FetchLike = async (url) => {
    if (url.includes("openrouter")) {
      return jsonResponse(200, { data: [] });
    }
    return jsonResponse(200, {
      vancine: {
        models: {
          "glm-5.3-flash": {
            id: "glm-5.3-flash",
            name: "GLM-5.3-Flash",
            reasoning: true,
            modalities: { input: ["text", "image", "video", "pdf"], output: ["text"] },
            limit: { context: 1000000, output: 131072 },
            cost: { input: 0.06, output: 0.2, cache_read: 0.012 },
          },
        },
      },
    });
  };
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });
  await manager.start();

  const result = manager.snapshot("glm-5.3-flash").lookup;
  assert.ok(result);
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.model.id, "glm-5.3-flash");
    assert.equal(result.model.name, "GLM-5.3-Flash");
    assert.equal(result.model.contextLength, 1000000);
    assert.equal(result.model.maxOutputTokens, 131072);
    assert.deepEqual(result.model.modalities, ["text", "image", "video"]);
    assert.equal(result.model.reasoning, true);
    assert.equal(result.model.pricing?.input, 0.06);
    assert.equal(result.model.pricing?.output, 0.2);
    assert.equal(result.model.pricing?.currency, "USD");
  }
});

test("catalog normalizes an openrouter-only entry and resolves its bare id", async () => {
  const fs = memFs();
  const fetchFn: FetchLike = async (url) => {
    if (url.includes("openrouter")) {
      return jsonResponse(200, {
        data: [
          {
            id: "z-ai/glm-5.3-flash",
            name: "Z.ai: GLM 5.3 Flash",
            context_length: 1310720,
            architecture: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
            top_provider: { context_length: 1048576, max_completion_tokens: 131072 },
            pricing: { prompt: "0.000000075", completion: "0.00000025" },
            supported_parameters: ["temperature", "reasoning", "reasoning_effort"],
          },
        ],
      });
    }
    return jsonResponse(200, {});
  };
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });
  await manager.start();

  for (const modelId of ["z-ai/glm-5.3-flash", "glm-5.3-flash"]) {
    const result = manager.snapshot(modelId).lookup;
    assert.ok(result);
    assert.equal(result.found, true, `lookup by "${modelId}" should hit`);
    if (result.found) {
      assert.equal(result.model.contextLength, 1310720);
      assert.equal(result.model.maxOutputTokens, 131072);
      assert.deepEqual(result.model.modalities, ["text", "image", "video"]);
      assert.equal(result.model.reasoning, true);
      assert.equal(result.model.pricing?.input, 0.000000075);
      assert.equal(result.model.pricing?.output, 0.00000025);
    }
  }
});

test("catalog merges a model present in both sources, models.dev winning conflicts", async () => {
  const fs = memFs();
  const fetchFn: FetchLike = async (url) => {
    if (url.includes("openrouter")) {
      return jsonResponse(200, {
        data: [
          {
            id: "z-ai/glm-5.3-flash",
            name: "Z.ai: GLM 5.3 Flash",
            context_length: 1310720,
            architecture: { input_modalities: ["text", "image", "video"] },
            top_provider: { max_completion_tokens: 131072 },
            pricing: { prompt: "0.000000075", completion: "0.00000025" },
            supported_parameters: ["reasoning"],
          },
        ],
      });
    }
    return jsonResponse(200, {
      openrouter: {
        models: {
          "z-ai/glm-5.3-flash": {
            id: "z-ai/glm-5.3-flash",
            name: "GLM-5.3-Flash",
            reasoning: true,
            modalities: { input: ["text", "image", "video"], output: ["text"] },
            limit: { context: 1000000, output: 131072 },
            cost: { input: 0.06, output: 0.2 },
          },
        },
      },
    });
  };
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });
  await manager.start();

  const result = manager.snapshot("z-ai/glm-5.3-flash").lookup;
  assert.ok(result);
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.model.name, "GLM-5.3-Flash"); // models.dev wins the name conflict
    assert.equal(result.model.contextLength, 1000000); // models.dev wins the context conflict
    assert.equal(result.model.maxOutputTokens, 131072);
    assert.deepEqual(result.model.modalities, ["text", "image", "video"]);
    assert.equal(result.model.reasoning, true);
    assert.equal(result.model.pricing?.input, 0.06); // models.dev cost wins over openrouter pricing
    assert.equal(result.model.pricing?.output, 0.2);
  }
});

test("catalog keeps openrouter fields when models.dev yields an empty husk", async () => {
  const fs = memFs();
  const fetchFn: FetchLike = async (url) => {
    if (url.includes("openrouter")) {
      return jsonResponse(200, {
        data: [
          {
            id: "z-ai/glm-5.3-flash",
            name: "Z.ai: GLM 5.3 Flash",
            context_length: 1310720,
            architecture: { input_modalities: ["text", "image", "video"] },
            top_provider: { max_completion_tokens: 131072 },
            pricing: { prompt: "0.000000075", completion: "0.00000025" },
            supported_parameters: ["reasoning"],
          },
        ],
      });
    }
    // A mirror entry missing limit/modalities/cost/reasoning (the pre-fix husk).
    return jsonResponse(200, {
      openrouter: {
        models: {
          "z-ai/glm-5.3-flash": { id: "z-ai/glm-5.3-flash", name: "GLM-5.3-Flash" },
        },
      },
    });
  };
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });
  await manager.start();

  const result = manager.snapshot("z-ai/glm-5.3-flash").lookup;
  assert.ok(result);
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.model.contextLength, 1310720);
    assert.equal(result.model.maxOutputTokens, 131072);
    assert.deepEqual(result.model.modalities, ["text", "image", "video"]);
    assert.equal(result.model.reasoning, true);
    assert.equal(result.model.pricing?.input, 0.000000075);
    assert.equal(result.model.pricing?.output, 0.00000025);
    assert.equal(result.model.name, "GLM-5.3-Flash"); // models.dev name still wins the non-null conflict
  }
});

test("catalog maps OpenRouter supported_efforts including max and omits none when mandatory", async () => {
  const fs = memFs();
  const fetchFn: FetchLike = async (url) => {
    if (url.includes("openrouter")) {
      return jsonResponse(200, {
        data: [
          {
            id: "z-ai/glm-5.3-flash",
            name: "Z.ai: GLM 5.3 Flash",
            reasoning: { mandatory: true, supported_efforts: ["max", "high", "low"] },
          },
        ],
      });
    }
    return jsonResponse(200, {});
  };
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });
  await manager.start();

  const result = manager.snapshot("z-ai/glm-5.3-flash").lookup;
  assert.ok(result);
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.model.reasoning, true);
    assert.deepEqual(result.model.reasoningLevels, ["default", "low", "high", "max"]);
    assert.equal(result.model.reasoningLevels.includes("none"), false);
  }
});

test("catalog maps models.dev reasoning_options effort plus toggle", async () => {
  const fs = memFs();
  const fetchFn: FetchLike = async (url) => {
    if (url.includes("openrouter")) {
      return jsonResponse(200, { data: [] });
    }
    return jsonResponse(200, {
      zai: {
        models: {
          "glm-5.3-flash": {
            id: "glm-5.3-flash",
            name: "GLM-5.3-Flash",
            reasoning: true,
            reasoning_options: [
              { type: "toggle" },
              { type: "effort", values: ["low", "high", "max"] },
            ],
          },
        },
      },
    });
  };
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });
  await manager.start();

  const result = manager.snapshot("glm-5.3-flash").lookup;
  assert.ok(result);
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.model.reasoning, true);
    assert.deepEqual(result.model.reasoningLevels, ["default", "none", "low", "high", "max"]);
  }
});

test("catalog unions reasoningLevels across records that share a bare id", async () => {
  const fs = memFs();
  const fetchFn: FetchLike = async (url) => {
    if (url.includes("openrouter")) {
      return jsonResponse(200, {
        data: [
          {
            id: "z-ai/glm-5.3-flash",
            name: "Z.ai: GLM 5.3 Flash",
            reasoning: { mandatory: false, supported_efforts: ["xhigh", "high"] },
          },
        ],
      });
    }
    return jsonResponse(200, {
      zai: {
        models: {
          "glm-5.3-flash": {
            id: "glm-5.3-flash",
            name: "GLM-5.3-Flash",
            reasoning: true,
            reasoning_options: [
              { type: "toggle" },
              { type: "effort", values: ["low", "high", "max"] },
            ],
          },
        },
      },
    });
  };
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });
  await manager.start();

  for (const modelId of ["z-ai/glm-5.3-flash", "glm-5.3-flash"]) {
    const result = manager.snapshot(modelId).lookup;
    assert.ok(result);
    assert.equal(result.found, true, `lookup by "${modelId}" should hit`);
    if (result.found) {
      assert.deepEqual(result.model.reasoningLevels, ["default", "none", "low", "high", "xhigh", "max"]);
    }
  }
});

test("catalog disk cache without reasoningLevels stays boolean-only", async () => {
  const fs = memFs();
  fs.write(
    cachePath,
    JSON.stringify({
      lastFetched: "t0",
      totalModels: 1,
      sources: [],
      models: {
        "z-ai/glm-5.3-flash": {
          id: "z-ai/glm-5.3-flash",
          name: "GLM",
          contextLength: null,
          maxOutputTokens: null,
          modalities: [],
          reasoning: true,
          pricing: null,
        },
      },
    }),
  );
  const fetchFn: FetchLike = async () => {
    throw new Error("down");
  };
  const manager = createCatalogManager({ fs, cachePath, fetchFn, now: clock() });
  await manager.start();

  const result = manager.snapshot("z-ai/glm-5.3-flash").lookup;
  assert.ok(result);
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.model.reasoning, true);
    assert.deepEqual(result.model.reasoningLevels, []);
  }
});
