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
  args?: Record<string, unknown>;
};

const stream = require(streamPath) as {
  mapFinishReason: (reason: string | undefined, n?: number) => string;
  jsonToHostParts: (
    json: unknown,
    voice?: { name: string; parameters?: unknown },
  ) => HostPart[];
  applyOpenAiEvent: (
    state: Record<string, unknown>,
    data: string,
  ) => { type: string; textDelta?: string }[];
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

test("jsonToHostParts maps leftover assistant text onto host SendToUser shape", () => {
  const parts = stream.jsonToHostParts({
    choices: [{
      finish_reason: "stop",
      message: { content: "Got it — you're connected, and here's your account and balance." },
    }],
  }, hostVoice);
  const voice = parts.find((p) => p.type === "tool-call" && p.toolName === "SendToUser");
  assert.equal(voice?.args?.content, "Got it — you're connected, and here's your account and balance.");
  assert.equal(voice?.args?.type, "text");
  assert.equal(parts.find((p) => p.type === "finish")?.finishReason, "tool-calls");
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

test("finishSse maps leftover SSE text onto host SendToUser", () => {
  const state = stream.newSseState();
  stream.applyOpenAiEvent(state, JSON.stringify({
    choices: [{ delta: { content: "Got it — you're connected." } }],
  }));
  stream.applyOpenAiEvent(state, JSON.stringify({
    choices: [{ finish_reason: "stop" }],
  }));
  const tail = stream.finishSse(state, hostVoice);
  assert.equal(tail[0]?.type, "tool-call");
  assert.equal(tail[0]?.toolName, "SendToUser");
  assert.equal(tail[0]?.args?.content, "Got it — you're connected.");
  assert.equal(tail[1]?.finishReason, "tool-calls");
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

test("findVoiceTool reads SendToUser off host tools", () => {
  const found = stream.findVoiceTool([
    { name: "SendToUser", parameters: { jsonSchema: { type: "object", properties: { content: {} } } } },
  ]);
  assert.equal(found?.name, "SendToUser");
});

async function withHopServer(
  reply: Record<string, unknown>,
  run: (runtime: {
    hopFullStream: (
      exec: { getMessages: () => unknown[] },
      agent: { modelId: string; maxOutputTokens: number },
      ctx?: unknown,
      invocationId?: string,
      tools?: unknown[],
    ) => { fullStream: AsyncIterable<HostPart> };
  }, seen: Record<string, unknown>[]) => Promise<void>,
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
    ) => { fullStream: AsyncIterable<HostPart> };
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

test("hopFullStream maps leftover stop text onto host SendToUser", async () => {
  const leftover = "Got it — you're connected, and here's your account and balance.";
  await withHopServer({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: leftover },
    }],
  }, async (runtime) => {
    const { fullStream } = runtime.hopFullStream(
      { getMessages: () => [{ role: "user", content: "x" }] },
      { modelId: "glm-5.3-flash", maxOutputTokens: 4096 },
      {},
      "inv",
      [hostVoice],
    );
    const parts: HostPart[] = [];
    for await (const part of fullStream) parts.push(part);
    const voice = parts.find((p) => p.type === "tool-call" && p.toolName === "SendToUser");
    assert.equal(voice?.args?.content, leftover);
    assert.equal(voice?.args?.type, "text");
    assert.equal(parts.find((p) => p.type === "finish")?.finishReason, "tool-calls");
  });
});
