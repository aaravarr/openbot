import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { anthropicSseToChat, anthropicToChat, chatToAnthropic, chatToResponses, responsesSseToChat, responsesToChat } from "./protocol-converters.ts";
const require = createRequire(import.meta.url);
const cjsConverters: any = require("../../payload/protocol-converters.cjs");

const request = {
  model: "model",
  stream: true,
  max_tokens: 90000,
  messages: [
    { role: "system", content: "Be concise" },
    { role: "user", content: "call the tool" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "done" },
  ],
  tools: [{ type: "function", function: { name: "lookup", description: "Find it", parameters: { type: "object", properties: { q: { type: "string" } } } } }],
};

test("Responses request and JSON response map tools, reasoning, finish, and usage", () => {
  const body = chatToResponses(request);
  assert.equal(body.max_output_tokens, 90000);
  assert.equal((body.input as { type: string }[])[3]?.type, "function_call");
  assert.equal((body.input as { type: string }[])[4]?.type, "function_call_output");
  const result = responsesToChat({ id: "resp_1", model: "model", status: "completed", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "think" }] }, { type: "message", content: [{ type: "output_text", text: "answer" }] }, { type: "function_call", call_id: "call_2", name: "lookup", arguments: "{}" }], usage: { input_tokens: 3, output_tokens: 4, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 2 } } }) as any;
  assert.equal(result.choices?.[0]?.finish_reason, "tool_calls");
  assert.equal(result.choices?.[0]?.message?.reasoning_content, "think");
  assert.equal(result.usage?.prompt_tokens, 3);
  assert.equal(result.usage?.completion_tokens_details?.reasoning_tokens, 2);
});

test("Responses honors the clamped max_output_tokens field", () => {
  const body = chatToResponses({ max_tokens: 90000, max_output_tokens: 65536 });
  assert.equal(body.max_output_tokens, 65536);
});

test("Responses content_filter wins over incomplete status", () => {
  const result = responsesToChat({ status: "incomplete", incomplete_details: { reason: "content_filter" } }) as any;
  assert.equal(result.choices?.[0]?.finish_reason, "content_filter");
});

test("UTF-8 tool-call ids are clamped identically in TS and CJS", () => {
  const id = "工具调用".repeat(30);
  const ts = chatToResponses({ messages: [{ role: "assistant", tool_calls: [{ id, function: { name: "x", arguments: "{}" } }] }] });
  const cjs = cjsConverters.chatToResponses({ messages: [{ role: "assistant", tool_calls: [{ id, function: { name: "x", arguments: "{}" } }] }] });
  const tsId = (ts.input as any[])[1].call_id;
  const cjsId = cjs.input[1].call_id;
  assert.equal(tsId, cjsId);
  assert.ok(Buffer.byteLength(tsId, "utf8") <= 64);
});

test("Responses SSE maps text, reasoning, tool deltas, and completion usage", () => {
  const raw = [
    `data: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "m" } })}`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}`,
    `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc", name: "lookup" } })}`,
    `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 }, output: [] } })}`,
    "data: [DONE]", "",
  ].join("\n\n");
  const text = responsesSseToChat(raw);
  assert.match(text, /\"content\":\"hi\"/);
  assert.match(text, /\"tool_calls\"/);
  assert.match(text, /\"finish_reason\":\"stop\"/);
  assert.match(text, /data: \[DONE\]/);
});

test("Anthropic request and JSON response map system, tool blocks, thinking, and cache usage", () => {
  const body = chatToAnthropic(request);
  assert.equal(body.system, "Be concise");
  assert.equal(body.max_tokens, 90000);
  assert.equal((body.messages as { role: string }[])[1]?.role, "assistant");
  const result = anthropicToChat({ id: "msg_1", model: "m", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "answer" }, { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }], stop_reason: "tool_use", usage: { input_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, output_tokens: 4 } }) as any;
  assert.equal(result.choices?.[0]?.finish_reason, "tool_calls");
  assert.equal(result.choices?.[0]?.message?.content, "answer");
  assert.equal(result.usage?.prompt_tokens, 9);
  assert.equal(result.usage?.prompt_tokens_details?.cached_tokens, 7);
  const thinking = (body.messages as any[])[1].content.find((part: any) => part.type === "thinking");
  assert.equal(thinking, undefined);
  const thinkingRequest = chatToAnthropic({ messages: [{ role: "assistant", reasoning_content: "private", content: "answer" }] });
  assert.deepEqual((thinkingRequest.messages as any[])[0].content[0], { type: "thinking", thinking: "private" });
});

test("Anthropic SSE maps text, thinking, tool JSON, stop reason, and usage", () => {
  const raw = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "m" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "why" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"q\":\"x\"}" } })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 2 } })}`,
    "event: message_stop\ndata: {\"type\":\"message_stop\"}", "",
  ].join("\n\n");
  const text = anthropicSseToChat(raw);
  assert.match(text, /\"content\":\"hi\"/);
  assert.match(text, /\"reasoning_content\":\"why\"/);
  assert.match(text, /\"tool_calls\"/);
  assert.match(text, /\"finish_reason\":\"stop\"/);
  assert.match(text, /\"prompt_tokens\":1/);
});

test("SSE parser accepts consecutive data lines without blank separators", () => {
  const raw = `data: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "m" } })}\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\ndata: [DONE]\n`;
  assert.match(responsesSseToChat(raw), /\"content\":\"ok\"/);
});
