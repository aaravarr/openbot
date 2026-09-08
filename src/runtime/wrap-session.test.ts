import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const runtimePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/runtime.cjs");

test("wrapSession is sync, replaces stream, and throws without a binding", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-rt-"));
  const planPath = path.join(dir, "plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      kind: "custom",
      agents: { "*": { modelId: "glm-5.3-flash", providerId: "zhipu" } },
      catalog: { providers: [], models: [], bindings: [] },
    }),
  );
  process.env.OPENBOT_PLAN = planPath;
  delete require.cache[runtimePath];
  const runtime = require(runtimePath) as {
    wrapSession: (stockFn: (...args: unknown[]) => unknown, args: unknown) => unknown;
    unwrapJsonSchemaTools: (tools: unknown[]) => { function: { parameters: { properties: Record<string, unknown> } } }[];
    mapToolCalls: (calls: unknown[]) => { toolName: string }[];
    defaultMaxTokens: (n: number | undefined, cap?: number) => number;
    resolveAgent: (args: unknown[]) => { modelId: string; maxOutputTokens: number } | null;
  };

  const tools = runtime.unwrapJsonSchemaTools([
    { name: "SendToUser", parameters: { jsonSchema: { type: "object", properties: { message: { type: "string" } } } } },
  ]);
  assert.equal(tools[0]?.function.parameters.properties.message !== undefined, true);

  const twice = runtime.mapToolCalls([
    { id: "a", function: { name: "SendToUser", arguments: "{}" } },
    { id: "b", function: { name: "SendToUser", arguments: "{}" } },
  ]);
  assert.equal(twice.length, 2);
  assert.equal(runtime.defaultMaxTokens(undefined), 65536);
  assert.equal(runtime.defaultMaxTokens(99999, 4096), 4096);

  function stockFn() {
    return {
      getSession() {
        return {
          getExecutor() {
            return { stream() { return { fullStream: (async function* () {})() }; }, getMessages() { return []; } };
          },
          getModelId() {
            return "grok";
          },
        };
      },
      getProviderName() {
        return "proto";
      },
      getModelId() {
        return "grok";
      },
      getThinkingDetails() {
        return undefined;
      },
    };
  }

  const provider = runtime.wrapSession(stockFn, [{ conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }]);
  assert.equal(typeof provider, "object");
  assert.equal(provider !== null && typeof (provider as { then?: unknown }).then, "undefined");
  const session = (provider as { getSession: (mw: unknown) => { getExecutor: () => { stream: unknown } } }).getSession(
    (exec: { stream: unknown }) => exec,
  );
  assert.equal(typeof session.getExecutor().stream, "function");

  writeFileSync(
    planPath,
    JSON.stringify({
      kind: "custom",
      agents: { "*": { modelId: "gpt-4.1", providerId: "openai" } },
      catalog: {
        providers: [],
        models: [{ id: "openai:gpt-4.1", providerId: "openai", slug: "gpt-4.1", maxOutputTokens: 2048 }],
        bindings: [],
      },
    }),
  );
  const agent = runtime.resolveAgent([{ conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }]);
  assert.equal(agent?.modelId, "gpt-4.1");
  assert.equal(agent?.maxOutputTokens, 2048);

  writeFileSync(planPath, JSON.stringify({ kind: "custom", agents: {}, catalog: { providers: [], models: [], bindings: [] } }));
  assert.throws(() => runtime.wrapSession(stockFn, [{}]), /no model binding/);
});

test("wrapSession chain re-resolves the plan on every stream and getModelId", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-rt-lazy-"));
  const planPath = path.join(dir, "plan.json");
  const writePlan = (modelId: string) =>
    writeFileSync(
      planPath,
      JSON.stringify({
        kind: "custom",
        agents: { "*": { modelId, providerId: "p" } },
        catalog: { providers: [], models: [], bindings: [] },
      }),
    );
  writePlan("model-a");

  const prevPlan = process.env.OPENBOT_PLAN;
  const prevHost = process.env.OPENBOT_HOP_HOST;
  const prevPort = process.env.OPENBOT_HOP_PORT;
  process.env.OPENBOT_PLAN = planPath;

  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        seen.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string }).model ?? "");
      } catch {
        seen.push("");
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  process.env.OPENBOT_HOP_HOST = "127.0.0.1";
  process.env.OPENBOT_HOP_PORT = String(addr.port);

  delete require.cache[runtimePath];
  const runtime = require(runtimePath) as {
    wrapSession: (stockFn: (...args: unknown[]) => unknown, args: unknown) => unknown;
  };
  try {
    function stockFn() {
      return {
        getSession() {
          return {
            getExecutor() {
              return {
                stream() {
                  throw new Error("stock stream should not run on custom wrap");
                },
                getMessages() {
                  return [{ role: "user", content: "hi" }];
                },
              };
            },
            getModelId() {
              return "stock";
            },
          };
        },
        getProviderName() {
          return "proto";
        },
        getModelId() {
          return "stock";
        },
      };
    }

    const provider = runtime.wrapSession(stockFn, [{}]) as {
      getModelId: () => string;
      getSession: (mw: unknown) => { getExecutor: () => { stream: Function }; getModelId: () => string };
    };
    assert.equal(provider.getModelId(), "model-a");

    const drain = async () => {
      const session = provider.getSession((exec: unknown) => exec);
      const result = session.getExecutor().stream({}, "inv-1", [], {}) as {
        fullStream: AsyncIterable<unknown>;
      };
      for await (const _part of result.fullStream) {
        /* drain */
      }
    };
    await drain();
    assert.deepEqual(seen, ["model-a"]);

    // Rewrite the plan without bouncing the host: the very next stream and
    // getModelId must use the new model.
    writePlan("model-b");
    assert.equal(provider.getModelId(), "model-b");
    const session = provider.getSession((exec: unknown) => exec);
    assert.equal(session.getModelId(), "model-b");
    await drain();
    assert.deepEqual(seen, ["model-a", "model-b"]);
  } finally {
    server.close();
    server.closeAllConnections();
    if (prevPlan === undefined) delete process.env.OPENBOT_PLAN;
    else process.env.OPENBOT_PLAN = prevPlan;
    if (prevHost === undefined) delete process.env.OPENBOT_HOP_HOST;
    else process.env.OPENBOT_HOP_HOST = prevHost;
    if (prevPort === undefined) delete process.env.OPENBOT_HOP_PORT;
    else process.env.OPENBOT_HOP_PORT = prevPort;
  }
});
