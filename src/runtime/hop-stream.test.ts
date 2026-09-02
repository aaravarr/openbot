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

const stream = require(streamPath) as {
  mapFinishReason: (reason: string | undefined, n?: number) => string;
  jsonToHostParts: (json: unknown) => { type: string; finishReason?: string; textDelta?: string; toolName?: string }[];
  applyOpenAiEvent: (
    state: Record<string, unknown>,
    data: string,
  ) => { type: string; textDelta?: string }[];
  newSseState: () => Record<string, unknown>;
  finishSse: (state: Record<string, unknown>) => { type: string; finishReason?: string; toolName?: string }[];
  iterateOpenAiResponse: (res: AsyncIterable<Buffer | string>) => AsyncGenerator<{ type: string; textDelta?: string; finishReason?: string }>;
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

test("hopFullStream posts stream true and maps a JSON fallback", async () => {
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
        res.end(JSON.stringify({
          choices: [{
            finish_reason: "stop",
            message: {
              content: "checking",
              tool_calls: [{ id: "c1", function: { name: "SendToUser", arguments: "{\"message\":\"x\"}" } }],
            },
          }],
        }));
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
    ) => { fullStream: AsyncIterable<{ type: string; finishReason?: string; toolName?: string }> };
  };
  try {
    const { fullStream } = runtime.hopFullStream(
      { getMessages: () => [{ role: "user", content: "x" }] },
      { modelId: "glm-5.3-flash", maxOutputTokens: 4096 },
    );
    const parts: { type: string; finishReason?: string; toolName?: string }[] = [];
    for await (const part of fullStream) parts.push(part);
    assert.equal(seen[0]?.stream, true);
    assert.equal(parts.some((p) => p.type === "tool-call" && p.toolName === "SendToUser"), true);
    assert.equal(parts.find((p) => p.type === "finish")?.finishReason, "tool-calls");
  } finally {
    server.server.close();
    if (prevPlan === undefined) delete process.env.OPENBOT_PLAN;
    else process.env.OPENBOT_PLAN = prevPlan;
    if (prevHost === undefined) delete process.env.OPENBOT_HOP_HOST;
    else process.env.OPENBOT_HOP_HOST = prevHost;
    if (prevPort === undefined) delete process.env.OPENBOT_HOP_PORT;
    else process.env.OPENBOT_HOP_PORT = prevPort;
  }
});
