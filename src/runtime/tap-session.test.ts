import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const runtimePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/runtime.cjs");
const logPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/request-log.cjs");

type StreamPart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  argsTextDelta?: string;
  args?: Record<string, unknown>;
  finishReason?: string;
};

type Runtime = {
  attachSession: (stockFn: (...args: unknown[]) => unknown, args: unknown) => unknown;
  wrapSession: (stockFn: (...args: unknown[]) => unknown, args: unknown) => unknown;
  tapSession: (stockFn: (...args: unknown[]) => unknown, args: unknown) => unknown;
  isCustomMode: () => boolean;
  jsonSafe: (value: unknown, depth?: number) => unknown;
};

type LogApi = {
  saveSettings: (input: unknown) => void;
  listRequests: (query?: unknown) => { items: Array<{ id: string; channel?: string; model?: string }>; total: number };
  getRequest: (id: string) => {
    channel?: string;
    request?: { messages?: unknown; tools?: unknown; requestedModel?: unknown };
    response?: { parts?: StreamPart[]; response?: { messages?: unknown } };
  } | null;
};

function loadRuntime(dir: string, mode: "official" | "custom"): Runtime {
  writeFileSync(path.join(dir, "openbot-mode"), `${mode}\n`);
  writeFileSync(
    path.join(dir, "openbot-plan.json"),
    JSON.stringify({
      kind: "custom",
      agents: { "*": { modelId: "glm-5.3-flash", providerId: "zhipu" } },
      catalog: { providers: [], models: [], bindings: [] },
    }),
  );
  process.env.OPENBOT_SAND_DATA = dir;
  process.env.OPENBOT_PLAN = path.join(dir, "openbot-plan.json");
  process.env.OPENBOT_MODE = path.join(dir, "openbot-mode");
  process.env.OPENBOT_SECRETS = path.join(dir, "secrets.json");
  writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ providers: {} }));
  delete require.cache[runtimePath];
  delete require.cache[logPath];
  return require(runtimePath) as Runtime;
}

function stockGrok(calls: { hop: boolean; middleware: unknown }) {
  return function stockFn() {
    return {
      getSession(middleware: unknown) {
        calls.middleware = middleware;
        return {
          getExecutor() {
            return {
              getMessages() {
                return [{ role: "user", content: "hi" }];
              },
              stream(_ctx: unknown, _id: unknown, _tools: unknown) {
                return {
                  fullStream: (async function* () {
                    yield {
                      type: "tool-call-streaming-start",
                      toolCallId: "t1",
                      toolName: "GetDynamicTools",
                    };
                    yield { type: "tool-call-delta", toolCallId: "t1", argsTextDelta: '{"ns":' };
                    yield {
                      type: "tool-call",
                      toolCallId: "t1",
                      toolName: "GetDynamicTools",
                      args: { namespace: "user-X" },
                    };
                    yield { type: "finish", finishReason: "tool-calls" };
                  })(),
                  response: Promise.resolve({
                    messages: [
                      {
                        role: "assistant",
                        content: [
                          {
                            type: "tool-call",
                            toolCallId: "t1",
                            toolName: "GetDynamicTools",
                            args: { namespace: "user-X" },
                          },
                        ],
                      },
                    ],
                  }),
                  usage: Promise.resolve({ promptTokens: 11, completionTokens: 6, totalTokens: 17 }),
                };
              },
            };
          },
          getModelId() {
            return "grok-4.5";
          },
        };
      },
      getModelId() {
        return "grok-4.5";
      },
      getProviderName() {
        return "proto";
      },
    };
  };
}

function hopStock(calls: { hop: boolean }) {
  return function stockFn() {
    calls.hop = true;
    return {
      getSession() {
        return {
          getExecutor() {
            return {
              stream() {
                calls.hop = true;
                throw new Error("stock stream should not run on custom wrap");
              },
              getMessages() {
                return [];
              },
            };
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
    };
  };
}

async function waitForLog(log: LogApi): Promise<string> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const listed = log.listRequests();
    if (listed.total > 0 && listed.items[0]?.id) {
      return listed.items[0].id;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("log row not written");
}

test("jsonSafe keeps stream parts and drops circular refs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-tap-"));
  const runtime = loadRuntime(dir, "official");
  const part = { type: "tool-call", args: { namespace: "user-X" } };
  assert.deepEqual(runtime.jsonSafe(part, 0), part);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const safe = runtime.jsonSafe(cyclic, 0) as { self: string };
  assert.equal(safe.self, "[circular]");
});

test("tapSession is sync, calls stock, yields original parts, and records host-stream", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-tap-"));
  const runtime = loadRuntime(dir, "official");
  const log = require(logPath) as LogApi;
  log.saveSettings({ loggingEnabled: true, logBodies: true, logBodiesOnError: true });

  const calls = { hop: false, middleware: undefined as unknown };
  const mw = function identity(exec: unknown) {
    return exec;
  };
  const provider = runtime.tapSession(stockGrok(calls), [{}, "grok-4.5", { thinking: "low" }, "chat"]);
  assert.equal(typeof provider, "object");
  assert.equal(provider !== null && typeof (provider as { then?: unknown }).then, "undefined");

  const session = (provider as { getSession: (mw: unknown) => { getExecutor: () => { stream: Function } } }).getSession(
    mw,
  );
  assert.equal(calls.middleware, mw);
  const result = session.getExecutor().stream({}, "inv-1", [{ name: "GetDynamicTools" }], { maxTokens: 2048 }) as {
    fullStream: AsyncIterable<StreamPart>;
  };
  const parts: StreamPart[] = [];
  for await (const part of result.fullStream) {
    parts.push(part);
  }
  assert.equal(parts[0]?.type, "tool-call-streaming-start");
  assert.equal(parts.some((row) => row.type === "tool-call" && row.toolName === "GetDynamicTools"), true);
  assert.equal(parts.at(-1)?.finishReason, "tool-calls");

  const id = await waitForLog(log);
  const detail = log.getRequest(id);
  assert.equal(detail?.channel, "official");
  assert.equal(detail?.response?.parts?.[0]?.type, "tool-call-streaming-start");
  const content = (detail?.response?.response as { messages?: Array<{ content?: Array<{ type?: string }> }> })
    ?.messages?.[0]?.content?.[0];
  assert.equal(content?.type, "tool-call");
  assert.equal(detail?.request?.requestedModel, "grok-4.5");
});

test("wrapSession on official taps stock and does not require a binding", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-tap-"));
  const runtime = loadRuntime(dir, "official");
  assert.equal(runtime.isCustomMode(), false);
  const calls = { hop: false, middleware: undefined as unknown };
  const provider = runtime.wrapSession(stockGrok(calls), [{}]);
  const session = (provider as { getSession: (mw: unknown) => { getExecutor: () => { stream: Function } } }).getSession(
    undefined,
  );
  const result = session.getExecutor().stream() as { fullStream: AsyncIterable<StreamPart> };
  const parts: StreamPart[] = [];
  for await (const part of result.fullStream) {
    parts.push(part);
  }
  assert.equal(parts.length, 4);
});

test("attachSession follows openbot-mode: custom still requires a binding", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-tap-"));
  const runtime = loadRuntime(dir, "custom");
  assert.equal(runtime.isCustomMode(), true);
  writeFileSync(
    path.join(dir, "openbot-plan.json"),
    JSON.stringify({ kind: "custom", agents: {}, catalog: { providers: [], models: [], bindings: [] } }),
  );
  const calls = { hop: false };
  assert.throws(() => runtime.attachSession(hopStock(calls), [{}]), /no model binding/);
  assert.equal(calls.hop, false);
});
