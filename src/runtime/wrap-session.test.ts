import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
    defaultMaxTokens: (n: number | undefined) => number;
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

  writeFileSync(planPath, JSON.stringify({ kind: "custom", agents: {}, catalog: { providers: [], models: [], bindings: [] } }));
  assert.throws(() => runtime.wrapSession(stockFn, [{}]), /no model binding/);
});
