import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const streamPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/openai-stream.cjs");
const runtimePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/runtime.cjs");

const hostVoice = {
  name: "SendToUser",
  parameters: {
    type: "object",
    properties: { type: { type: "string" }, content: { type: "string" } },
    required: ["type"],
  },
};

type HostPart = {
  type: string;
  finishReason?: string;
  textDelta?: string;
  toolName?: string;
  toolCallId?: string;
  argsTextDelta?: string;
  args?: Record<string, unknown>;
  id?: string;
};

type AssistantPart = {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
};

type HopResult = {
  fullStream: AsyncIterable<HostPart>;
  response: Promise<{
    id?: string;
    modelId?: string;
    messages: Array<{ role: string; content: AssistantPart[] }>;
  }>;
};

// The pure ctx extractor, loaded once for the frame-chain cases below. The
// hop-end tests re-require the module inside withHopServer, after the env is
// pointed at their temporary plan, so this instance never carries their state.
const ctxRuntime = require(runtimePath) as {
  conversationIdFromCtx: (ctx: unknown) => string;
};

const stream = require(streamPath) as {
  mapFinishReason: (reason: string | undefined, n?: number) => string;
  assistantMessageContent: (parts: HostPart[]) => AssistantPart[];
  jsonToHostParts: (
    json: unknown,
    voice?: { name: string; parameters?: unknown },
  ) => HostPart[];
  applyOpenAiEvent: (
    state: Record<string, unknown>,
    data: string,
  ) => HostPart[];
  newSseState: () => Record<string, unknown>;
  finishSse: (
    state: Record<string, unknown>,
    voice?: { name: string; parameters?: unknown },
  ) => HostPart[];
  iterateOpenAiResponse: (
    res: AsyncIterable<Buffer | string>,
    voice?: { name: string; parameters?: unknown },
  ) => AsyncGenerator<HostPart>;
  findVoiceTool: (tools: unknown[]) => { name: string } | null;
  mapAssistantTextToVoice: (
    text: string,
    mapped: { toolName: string }[],
    voice: { name: string; parameters?: unknown } | null,
  ) => { toolName: string; args?: Record<string, unknown> }[];
};

test("jsonToHostParts treats stop plus tool_calls as host tool-calls", () => {
  const parts = stream.jsonToHostParts({
    id: "cmpl",
    choices: [{
      finish_reason: "stop",
      message: {
        content: "能！X 已经连上了，我来看看你的账号情况。",
        tool_calls: [
          { id: "c1", function: { name: "get_users_me", arguments: "{}" } },
        ],
      },
    }],
  });
  assert.equal(parts.some((p) => p.type === "text-delta"), true);
  assert.equal(parts.some((p) => p.type === "tool-call" && p.toolName === "get_users_me"), true);
  const finish = parts.find((p) => p.type === "finish");
  assert.equal(finish?.finishReason, "tool-calls");
});

test("jsonToHostParts reads array content instead of dropping it", () => {
  const parts = stream.jsonToHostParts({
    choices: [{
      finish_reason: "stop",
      message: { content: [{ type: "text", text: "hello" }] },
    }],
  });
  assert.equal(parts[0]?.type, "text-delta");
  assert.equal(parts[0]?.textDelta, "hello");
});

test("jsonToHostParts does not map leftover assistant text onto SendToUser", () => {
  const leftover = "Got it — you're connected, and here's your account and balance.";
  const parts = stream.jsonToHostParts({
    choices: [{
      finish_reason: "stop",
      message: { content: leftover },
    }],
  }, hostVoice);
  assert.equal(parts.some((p) => p.type === "tool-call"), false);
  assert.equal(parts[0]?.type, "text-delta");
  assert.equal(parts[0]?.textDelta, leftover);
  assert.equal(parts.find((p) => p.type === "finish")?.finishReason, "stop");
});

test("jsonToHostParts does not invent SendToUser text when the model wrote nothing", () => {
  const parts = stream.jsonToHostParts({
    choices: [{
      finish_reason: "stop",
      message: { content: "" },
    }],
  }, hostVoice);
  assert.equal(parts.some((p) => p.type === "tool-call"), false);
  assert.equal(parts.find((p) => p.type === "finish")?.finishReason, "stop");
});

test("jsonToHostParts does not wrap scratch reasoning JSON as SendToUser", () => {
  const parts = stream.jsonToHostParts({
    choices: [{
      finish_reason: "stop",
      message: { content: "{\"type\":\"reasoning\",\"text\":\"retry credits\"}" },
    }],
  }, hostVoice);
  assert.equal(parts.some((p) => p.type === "tool-call"), false);
});

test("jsonToHostParts does not add SendToUser beside the model's other tools", () => {
  const parts = stream.jsonToHostParts({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "我先看看查用户帖子和阅读量的工具和参数有啥。",
        tool_calls: [
          { id: "c1", function: { name: "GetDynamicTools", arguments: "{\"namespace\":\"user-X\",\"toolName\":\"get_users_posts\"}" } },
        ],
      },
    }],
  }, hostVoice);
  assert.equal(parts.some((p) => p.type === "tool-call" && p.toolName === "SendToUser"), false);
  assert.equal(parts.some((p) => p.type === "tool-call" && p.toolName === "GetDynamicTools"), true);
  assert.equal(parts.find((p) => p.type === "finish")?.finishReason, "tool-calls");
});

test("jsonToHostParts emits start then delta then complete tool-call", () => {
  const parts = stream.jsonToHostParts({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "checking",
        tool_calls: [
          { id: "c1", function: { name: "GetDynamicTools", arguments: "{\"namespace\":\"user-X\"}" } },
        ],
      },
    }],
  });
  assert.deepEqual(parts.map((p) => p.type), [
    "text-delta",
    "tool-call-streaming-start",
    "tool-call-delta",
    "tool-call",
    "finish",
  ]);
  assert.equal(parts[1]?.toolCallId, "c1");
  assert.equal(parts[1]?.toolName, "GetDynamicTools");
  assert.equal(parts[2]?.toolCallId, "c1");
  assert.equal(parts[2]?.argsTextDelta, "{\"namespace\":\"user-X\"}");
  assert.equal(parts[3]?.type, "tool-call");
  assert.equal(parts[3]?.toolName, "GetDynamicTools");
  assert.deepEqual(parts[3]?.args, { namespace: "user-X" });
});

test("jsonToHostParts does not map host reminder leftover as SendToUser", () => {
  const leftover = "<system_reminder>\nAcknowledge them RIGHT NOW\n</system_reminder>";
  const parts = stream.jsonToHostParts({
    choices: [{
      finish_reason: "stop",
      message: { content: leftover },
    }],
  }, hostVoice);
  assert.equal(parts.some((p) => p.type === "tool-call"), false);
  assert.equal(parts.some((p) => p.type === "text-delta" && p.textDelta === leftover), true);
  assert.equal(parts.find((p) => p.type === "finish")?.finishReason, "stop");
});

test("SSE deltas assemble tool arguments and finish as tool-calls", () => {
  const state = stream.newSseState();
  stream.applyOpenAiEvent(state, JSON.stringify({
    choices: [{ delta: { content: "先看一眼。" } }],
  }));
  stream.applyOpenAiEvent(state, JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: "call_x", function: { name: "get_users_me", arguments: "{\"id\"" } }],
      },
    }],
  }));
  stream.applyOpenAiEvent(state, JSON.stringify({
    choices: [{
      delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] },
      finish_reason: "stop",
    }],
  }));
  const tail = stream.finishSse(state);
  assert.equal(tail[0]?.type, "tool-call");
  assert.equal(tail[0]?.toolName, "get_users_me");
  assert.equal(tail[1]?.finishReason, "tool-calls");
});

test("applyOpenAiEvent emits tool-call-streaming-start then tool-call-delta", () => {
  const state = stream.newSseState();
  const first = stream.applyOpenAiEvent(state, JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: "call_x", function: { name: "get_users_me", arguments: "{\"id\"" } }],
      },
    }],
  }));
  assert.equal(first[0]?.type, "tool-call-streaming-start");
  assert.equal(first[0]?.toolCallId, "call_x");
  assert.equal(first[0]?.toolName, "get_users_me");
  assert.equal(first[1]?.type, "tool-call-delta");
  assert.equal(first[1]?.argsTextDelta, "{\"id\"");
  const second = stream.applyOpenAiEvent(state, JSON.stringify({
    choices: [{
      delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] },
      finish_reason: "tool_calls",
    }],
  }));
  assert.equal(second[0]?.type, "tool-call-delta");
  assert.equal(second[0]?.argsTextDelta, ":1}");
  const tail = stream.finishSse(state);
  assert.equal(tail[0]?.type, "tool-call");
  assert.equal(tail[0]?.toolName, "get_users_me");
  assert.deepEqual(tail[0]?.args, { id: 1 });
  assert.equal(tail[1]?.finishReason, "tool-calls");
});

test("finishSse keeps GetDynamicTools and does not invent SendToUser beside it", () => {
  const state = stream.newSseState();
  stream.applyOpenAiEvent(state, JSON.stringify({
    choices: [{ delta: { content: "我先看看查工具参数。" } }],
  }));
  stream.applyOpenAiEvent(state, JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_x",
          function: { name: "GetDynamicTools", arguments: "{\"namespace\":\"user-X\"}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }));
  const tail = stream.finishSse(state, hostVoice);
  assert.equal(tail.some((p) => p.type === "tool-call" && p.toolName === "SendToUser"), false);
  assert.equal(tail[0]?.toolName, "GetDynamicTools");
  assert.equal(tail[1]?.finishReason, "tool-calls");
});

test("finishSse does not map leftover SSE text onto SendToUser", () => {
  const state = stream.newSseState();
  stream.applyOpenAiEvent(state, JSON.stringify({
    choices: [{ delta: { content: "Got it — you're connected." } }],
  }));
  stream.applyOpenAiEvent(state, JSON.stringify({
    choices: [{ finish_reason: "stop" }],
  }));
  const tail = stream.finishSse(state, hostVoice);
  assert.equal(tail.some((p) => p.type === "tool-call"), false);
  assert.equal(tail[0]?.type, "finish");
  assert.equal(tail[0]?.finishReason, "stop");
});

test("finishSse does not invent a second SendToUser when the model already called it", () => {
  const state = stream.newSseState();
  stream.applyOpenAiEvent(state, JSON.stringify({
    choices: [{
      delta: {
        content: "ignored leftover",
        tool_calls: [{
          index: 0,
          id: "c1",
          function: { name: "SendToUser", arguments: "{\"content\":\"hi\",\"type\":\"text\"}" },
        }],
      },
    }],
  }));
  const tail = stream.finishSse(state, hostVoice);
  const voices = tail.filter((p) => p.type === "tool-call" && p.toolName === "SendToUser");
  assert.equal(voices.length, 1);
  assert.equal(voices[0]?.args?.content, "hi");
});

test("mapAssistantTextToVoice leaves leftover text as leftover", () => {
  const mapped = stream.mapAssistantTextToVoice(
    "I've fetched your mentions and delivered a summary.",
    [],
    hostVoice,
  );
  assert.deepEqual(mapped, []);
});

test("iterateOpenAiResponse yields text-delta before the SSE stream ends", async () => {
  async function* chunks() {
    yield Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
    yield Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\"!\"},\"finish_reason\":\"stop\"}]}\n\n");
    yield Buffer.from("data: [DONE]\n\n");
  }
  const types: string[] = [];
  const texts: string[] = [];
  for await (const part of stream.iterateOpenAiResponse(chunks())) {
    types.push(part.type);
    if (part.textDelta) texts.push(part.textDelta);
  }
  assert.deepEqual(texts, ["hi", "!"]);
  assert.equal(types[0], "text-delta");
  assert.equal(types[types.length - 1], "finish");
});

test("iterateOpenAiResponse yields tool-call-streaming-start before the complete tool-call", async () => {
  async function* chunks() {
    yield Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
    yield Buffer.from(
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"GetDynamicTools\",\"arguments\":\"{\\\"n\\\"}\"}}]}}]}\n\n",
    );
    yield Buffer.from(
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"ame\\\":1}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
    );
    yield Buffer.from("data: [DONE]\n\n");
  }
  const types: string[] = [];
  for await (const part of stream.iterateOpenAiResponse(chunks())) {
    types.push(part.type);
  }
  const start = types.indexOf("tool-call-streaming-start");
  const complete = types.indexOf("tool-call");
  assert.equal(types.includes("text-delta"), true);
  assert.equal(types.includes("tool-call-delta"), true);
  assert.ok(start >= 0 && complete > start);
  assert.equal(types[types.length - 1], "finish");
});

test("findVoiceTool reads SendToUser off host tools", () => {
  const found = stream.findVoiceTool([
    { name: "SendToUser", parameters: { jsonSchema: { type: "object", properties: { content: {} } } } },
  ]);
  assert.equal(found?.name, "SendToUser");
});

test("assistantMessageContent keeps text and tool-call parts together", () => {
  const content = stream.assistantMessageContent([
    { type: "text-delta", textDelta: "先看一眼。" },
    { type: "tool-call-streaming-start", toolCallId: "c1", toolName: "GetDynamicTools" },
    { type: "tool-call-delta", toolCallId: "c1", argsTextDelta: "{}" },
    {
      type: "tool-call",
      toolCallId: "c1",
      toolName: "GetDynamicTools",
      args: { namespace: "user-X" },
    },
    { type: "finish", finishReason: "tool-calls" },
  ]);
  assert.equal(content.length, 2);
  assert.deepEqual(content[0], { type: "text", text: "先看一眼。" });
  assert.equal(content[1]?.type, "tool-call");
  assert.equal(content[1]?.toolName, "GetDynamicTools");
  assert.equal(content[1]?.toolCallId, "c1");
  assert.deepEqual(content[1]?.args, { namespace: "user-X" });
});

test("assistantMessageContent keeps text beside a model SendToUser", () => {
  const content = stream.assistantMessageContent([
    { type: "text-delta", textDelta: "Got it — you're connected." },
    {
      type: "tool-call",
      toolCallId: "c1",
      toolName: "SendToUser",
      args: { content: "hi", type: "text" },
    },
    { type: "finish", finishReason: "tool-calls" },
  ]);
  assert.equal(content[0]?.type, "text");
  assert.equal(content[1]?.type, "tool-call");
  assert.equal(content[1]?.toolName, "SendToUser");
});

async function withHopServer(
  reply: Record<string, unknown>,
  run: (
    runtime: {
      hopFullStream: (
        exec: { getMessages: () => unknown[] },
        agent: { modelId: string; maxOutputTokens: number },
        ctx?: unknown,
        invocationId?: string,
        tools?: unknown[],
      ) => HopResult;
    },
    seen: Record<string, unknown>[],
  ) => Promise<void>,
) {
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
  const seen: Record<string, unknown>[] = [];
  const server = await new Promise<{ server: http.Server; port: number }>((resolve) => {
    const s = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({ server: s, port: addr.port });
    });
  });
  const prevPlan = process.env.OPENBOT_PLAN;
  const prevHost = process.env.OPENBOT_HOP_HOST;
  const prevPort = process.env.OPENBOT_HOP_PORT;
  process.env.OPENBOT_PLAN = planPath;
  process.env.OPENBOT_HOP_HOST = "127.0.0.1";
  process.env.OPENBOT_HOP_PORT = String(server.port);
  delete require.cache[runtimePath];
  const runtime = require(runtimePath) as {
    hopFullStream: (
      exec: { getMessages: () => unknown[] },
      agent: { modelId: string; maxOutputTokens: number },
      ctx?: unknown,
      invocationId?: string,
      tools?: unknown[],
    ) => HopResult;
  };
  try {
    await run(runtime, seen);
  } finally {
    server.server.close();
    if (prevPlan === undefined) delete process.env.OPENBOT_PLAN;
    else process.env.OPENBOT_PLAN = prevPlan;
    if (prevHost === undefined) delete process.env.OPENBOT_HOP_HOST;
    else process.env.OPENBOT_HOP_HOST = prevHost;
    if (prevPort === undefined) delete process.env.OPENBOT_HOP_PORT;
    else process.env.OPENBOT_HOP_PORT = prevPort;
  }
}

test("hopFullStream posts stream true and maps a JSON fallback", async () => {
  await withHopServer({
    choices: [{
      finish_reason: "stop",
      message: {
        content: "checking",
        tool_calls: [{ id: "c1", function: { name: "SendToUser", arguments: "{\"message\":\"x\"}" } }],
      },
    }],
  }, async (runtime, seen) => {
    const { fullStream } = runtime.hopFullStream(
      { getMessages: () => [{ role: "user", content: "x" }] },
      { modelId: "glm-5.3-flash", maxOutputTokens: 4096 },
    );
    const parts: HostPart[] = [];
    for await (const part of fullStream) parts.push(part);
    assert.equal(seen[0]?.stream, true);
    assert.equal(parts.some((p) => p.type === "tool-call" && p.toolName === "SendToUser"), true);
    assert.equal(parts.find((p) => p.type === "finish")?.finishReason, "tool-calls");
  });
});

test("hopFullStream stamps a flat ctx conversationId (legacy callers and fixtures)", async () => {
  // The stock harness calls \.stream(ctx, invocationId, tools, options) and the
  // ctx carries conversationId; the session factory args carry none. Reading
  // only the factory args left every production turn with an empty identity.
  // The real harness ctx is a frame chain -- see the ContextImpl section below.
  const conversationId = "3f1c0d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
  await withHopServer({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
  }, async (runtime, seen) => {
    const { fullStream } = runtime.hopFullStream(
      { getMessages: () => [{ role: "user", content: "hello" }] },
      { modelId: "glm-5.3-flash", maxOutputTokens: 4096 },
      { conversationId },
      "inv",
      [],
    );
    for await (const part of fullStream) void part;
    assert.equal(seen[0]?.conversationId, conversationId);
    assert.equal(typeof seen[0]?.epochId, "string");
    assert.notEqual(String(seen[0]?.epochId), "");
  });
});

test("hopFullStream stamps nothing when no conversation identity is observable", async () => {
  await withHopServer({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
  }, async (runtime, seen) => {
    const { fullStream } = runtime.hopFullStream(
      { getMessages: () => [{ role: "user", content: "hello" }] },
      { modelId: "glm-5.3-flash", maxOutputTokens: 4096 },
      { conversationGroupId: "" },
      "inv",
      [],
    );
    for await (const part of fullStream) void part;
    assert.equal(seen[0]?.conversationId, undefined);
    assert.equal(seen[0]?.epochId, undefined);
  });
});

// ---------------------------------------------------------------------------
// The harness ContextImpl turn ctx (../packages/context/dist/core.js)
//
// The wrapped call site receives the TOP frame of a parent chain, and the
// identity sits on an ancestor frame:
//   - `.with(key, value)` mints a frame whose `values` Map copies its DIRECT
//     parent's values and adds the key;
//   - `.withName(name)` mints a frame whose `values` is an EMPTY Map, so every
//     value below it stops being visible from above;
//   - `.get(key)` walks `parent` upwards.
// The turn bootstrap stamps
// `runCtx.with(conversationIdKey, host.getTranscriptId())...`, where the key is
// `createKey(Symbol("conversationId"), undefined)`. Box evidence (2026-09-14):
// the boundary frame's `values` held only `otel.span`, so a bounded walk that
// counted two levels per frame (one frame = frame -> parent -> frame.values)
// could never reach the identity.
// ---------------------------------------------------------------------------

type CtxFrame = {
  parent?: CtxFrame | undefined;
  values: Map<unknown, unknown>;
  name?: string;
  signal?: unknown;
};

const CONVERSATION_ID_SYMBOL = Symbol("conversationId");

/** `.with(key, value)`: values = a copy of the direct parent's values + key. */
function frameWith(parent: CtxFrame | undefined, key: unknown, value: unknown): CtxFrame {
  const values = new Map<unknown, unknown>(parent ? parent.values : []);
  values.set(key, value);
  return { parent, values, name: "with" };
}

/** `.withName(name)`: the new frame's values Map is EMPTY. */
function frameNamed(parent: CtxFrame, name: string): CtxFrame {
  return { parent, values: new Map<unknown, unknown>(), name };
}

/**
 * The production shape: the bootstrap frame carries the identity, the rest of
 * the turn stacks withName frames on top of it, and the frame handed to
 * `.stream(ctx, ...)` only adds its own span key on top of an empty Map.
 */
function harnessTurnCtx(conversationId: string, resets = 10): CtxFrame {
  let frame = frameWith(undefined, CONVERSATION_ID_SYMBOL, conversationId);
  frame = frameWith(frame, "otel.span", { traceId: "turn" });
  for (let i = 0; i < resets; i++) frame = frameNamed(frame, "span-" + String(i));
  return frameWith(frame, "otel.span", { traceId: "stream" });
}

function frameKeys(frame: CtxFrame): string[] {
  return Array.from(frame.values.keys()).map((key) =>
    typeof key === "string" ? key : String((key as symbol).description ?? ""));
}

test("the boundary frame hides the identity: only the full-chain walk finds it", () => {
  const conversationId = "3f1c0d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
  const ctx = harnessTurnCtx(conversationId);
  // The bug's precondition: the frame the wrapped call site sees holds only the
  // span key, and its values Map copies an EMPTY withName frame.
  assert.deepEqual(frameKeys(ctx), ["otel.span"]);
  assert.equal(ctxRuntime.conversationIdFromCtx(ctx), conversationId);
});

test("the identity sits further up than the old depth bound could reach", () => {
  const ctx = harnessTurnCtx("deep-chain-id", 10);
  // Three frame hops up (the most the old walk reached) hold no identity: the
  // six-level bound spent two levels per frame (frame -> parent -> values).
  let frame: CtxFrame | undefined = ctx;
  for (let hop = 0; hop < 3 && frame; hop++) {
    assert.equal(
      Array.from(frame.values.keys()).some((key) => key === CONVERSATION_ID_SYMBOL),
      false,
      "hop " + String(hop) + " must not carry the identity",
    );
    frame = frame.parent;
  }
  assert.equal(ctxRuntime.conversationIdFromCtx(ctx), "deep-chain-id");
});

test("a cyclic parent chain terminates instead of looping forever", () => {
  const a: CtxFrame = { values: new Map<unknown, unknown>([["otel.span", "a"]]), name: "a" };
  const b: CtxFrame = { parent: a, values: new Map<unknown, unknown>(), name: "b" };
  a.parent = b; // the frame points back at its own child
  assert.equal(ctxRuntime.conversationIdFromCtx(a), "");
  assert.equal(ctxRuntime.conversationIdFromCtx(b), "");
});

test("a cycle below a reachable identity still returns the nearest hit", () => {
  const conversationId = "cycle-id";
  const ctx = harnessTurnCtx(conversationId, 4);
  let bottom: CtxFrame = ctx;
  while (bottom.parent) bottom = bottom.parent;
  bottom.parent = ctx; // close the chain into a cycle
  assert.equal(ctxRuntime.conversationIdFromCtx(ctx), conversationId);
});

test("the nearest frame wins over an ancestor carrying an older identity", () => {
  const stale = "11111111-1111-4111-8111-111111111111";
  const fresh = "22222222-2222-4222-8222-222222222222";
  let frame = frameWith(undefined, CONVERSATION_ID_SYMBOL, stale);
  frame = frameNamed(frame, "boundary");
  frame = frameWith(frame, CONVERSATION_ID_SYMBOL, fresh);
  assert.equal(ctxRuntime.conversationIdFromCtx(frame), fresh);
});

test("no identity anywhere in a deep chain reads as empty", () => {
  let frame = frameWith(undefined, "otel.span", { traceId: "t" });
  for (let i = 0; i < 10; i++) frame = frameNamed(frame, "span-" + String(i));
  assert.equal(ctxRuntime.conversationIdFromCtx(frame), "");
  assert.equal(ctxRuntime.conversationIdFromCtx(undefined), "");
  assert.equal(ctxRuntime.conversationIdFromCtx("nope"), "");
});

test("loose container shapes still read: flat objects, wrapped values, empty ids", () => {
  assert.equal(ctxRuntime.conversationIdFromCtx({ conversationId: "flat-id" }), "flat-id");
  assert.equal(ctxRuntime.conversationIdFromCtx({ values: new Map([["conversationId", "map-id"]]) }), "map-id");
  assert.equal(ctxRuntime.conversationIdFromCtx({ context: { sessionId: "session-id" } }), "session-id");
  assert.equal(ctxRuntime.conversationIdFromCtx({ conversationGroupId: "" }), "");
  assert.equal(ctxRuntime.conversationIdFromCtx({ conversationId: "" }), "");
});

test("hopFullStream stamps the identity out of the deep harness ctx chain", async () => {
  const conversationId = "3f1c0d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
  await withHopServer({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
  }, async (runtime, seen) => {
    const { fullStream } = runtime.hopFullStream(
      { getMessages: () => [{ role: "user", content: "hello" }] },
      { modelId: "glm-5.3-flash", maxOutputTokens: 4096 },
      harnessTurnCtx(conversationId, 12),
      "inv",
      [],
    );
    for await (const part of fullStream) void part;
    assert.equal(seen[0]?.conversationId, conversationId);
    assert.equal(typeof seen[0]?.epochId, "string");
    assert.notEqual(String(seen[0]?.epochId), "");
  });
});

test("hopFullStream survives a cyclic ctx chain and stamps nothing", async () => {
  await withHopServer({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
  }, async (runtime, seen) => {
    const a: CtxFrame = { values: new Map<unknown, unknown>([["otel.span", "a"]]), name: "a" };
    const b: CtxFrame = { parent: a, values: new Map<unknown, unknown>(), name: "b" };
    a.parent = b;
    const { fullStream } = runtime.hopFullStream(
      { getMessages: () => [{ role: "user", content: "hello" }] },
      { modelId: "glm-5.3-flash", maxOutputTokens: 4096 },
      b,
      "inv",
      [],
    );
    for await (const part of fullStream) void part;
    assert.equal(seen[0]?.conversationId, undefined);
    assert.equal(seen[0]?.epochId, undefined);
  });
});

test("hopFullStream leaves leftover stop text as text, not SendToUser", async () => {
  const leftover = "Got it — you're connected, and here's your account and balance.";
  await withHopServer({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: leftover },
    }],
  }, async (runtime) => {
    const result = runtime.hopFullStream(
      { getMessages: () => [{ role: "user", content: "x" }] },
      { modelId: "glm-5.3-flash", maxOutputTokens: 4096 },
      {},
      "inv",
      [hostVoice],
    );
    const parts: HostPart[] = [];
    for await (const part of result.fullStream) parts.push(part);
    assert.equal(parts.some((p) => p.type === "tool-call"), false);
    assert.equal(parts.some((p) => p.type === "text-delta" && p.textDelta === leftover), true);
    assert.equal(parts.find((p) => p.type === "finish")?.finishReason, "stop");
    const response = await result.response;
    const content = response.messages[0]?.content;
    assert.equal(content?.some((p) => p.type === "text" && p.text === leftover), true);
    assert.equal(content?.some((p) => p.type === "tool-call"), false);
  });
});

test("hopFullStream posts host reminder and hidden-prompt text unchanged", async () => {
  const query =
    "<timestamp>Wednesday, Sep 2, 2026, 3:35 PM (UTC+8)</timestamp>\n<user_query>\n[t1u]\n你看看\n\n<system_reminder>\nYou opened this turn by calling tools without first acknowledging the user\n</system_reminder>\n</user_query>";
  const reminderOnly =
    "<system_reminder>\nYou opened this turn by calling tools without first acknowledging the user, so they are watching silence\n</system_reminder>";
  const redrive =
    "<timestamp>Wednesday, Sep 2, 2026, 3:37 PM (UTC+8)</timestamp>\n<user_query>\n[SAND_HIDDEN_PROMPT][ack-redrive-1f661e5f-9e4c-4e49-863a-180a41fae668]\n[System recovery] The user sent one or more messages\n</user_query>";
  const nudge =
    "[SAND_HIDDEN_PROMPT] Your previous turn left the user without the result they're waiting on — you never called SendToUser. Invoke SendToUser now with the result.";
  await withHopServer({
    choices: [{
      finish_reason: "stop",
      message: { content: "ok" },
    }],
  }, async (runtime, seen) => {
    const { fullStream } = runtime.hopFullStream(
      {
        getMessages: () => [
          { role: "user", content: query },
          { role: "user", content: reminderOnly },
          { role: "user", content: redrive },
          { role: "user", content: nudge },
        ],
      },
      { modelId: "glm-5.3-flash", maxOutputTokens: 4096 },
    );
    const parts: HostPart[] = [];
    for await (const part of fullStream) parts.push(part);
    const posted = seen[0]?.messages as Array<{ role: string; content: string }> | undefined;
    assert.equal(posted?.length, 4);
    assert.equal(posted?.[0]?.content, query);
    assert.equal(posted?.[1]?.content, reminderOnly);
    assert.equal(posted?.[2]?.content, redrive);
    assert.equal(posted?.[3]?.content, nudge);
    assert.equal(parts.some((p) => p.type === "tool-call"), false);
  });
});

test("hopFullStream settles response.messages with text and tool-call", async () => {
  await withHopServer({
    id: "cmpl-1",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "checking",
        tool_calls: [{
          id: "c1",
          function: { name: "GetDynamicTools", arguments: "{\"namespace\":\"user-X\"}" },
        }],
      },
    }],
  }, async (runtime) => {
    const result = runtime.hopFullStream(
      { getMessages: () => [{ role: "user", content: "x" }] },
      { modelId: "glm-5.3-flash", maxOutputTokens: 4096 },
    );
    const parts: HostPart[] = [];
    for await (const part of result.fullStream) parts.push(part);
    assert.equal(parts[0]?.type, "text-delta");
    assert.equal(parts.some((p) => p.type === "tool-call-streaming-start"), true);
    assert.equal(parts.some((p) => p.type === "tool-call-delta"), true);
    assert.equal(parts.some((p) => p.type === "tool-call" && p.toolName === "GetDynamicTools"), true);
    const response = await result.response;
    const content = response.messages[0]?.content;
    assert.equal(content?.some((p) => p.type === "text" && p.text === "checking"), true);
    assert.equal(content?.some((p) => p.type === "tool-call" && p.toolName === "GetDynamicTools"), true);
    assert.equal(response.id, "cmpl-1");
    assert.equal(response.modelId, "glm-5.3-flash");
  });
});
