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
  const parts = stream.jsonToHostParts({
    choices: [{
      finish_reason: "stop",
      message: { content: "<system_reminder>\nAcknowledge them RIGHT NOW\n</system_reminder>" },
    }],
  }, hostVoice);
  assert.equal(parts.some((p) => p.type === "tool-call"), false);
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
