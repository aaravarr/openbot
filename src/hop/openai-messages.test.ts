import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { toOpenAIMessages } = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/openai-messages.cjs")) as {
  toOpenAIMessages: (msgs: unknown) => {
    role: string;
    content: string;
    tool_call_id?: string;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  }[];
};

test("toOpenAIMessages copies camelCase toolCallId onto tool messages", () => {
  const out = toOpenAIMessages([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_abc", type: "function", function: { name: "Read", arguments: "{}" } }],
    },
    { role: "tool", toolCallId: "call_abc", content: "ok" },
  ]);
  assert.equal(out[2]?.role, "tool");
  assert.equal(out[2]?.tool_call_id, "call_abc");
  assert.equal(out[2]?.content, "ok");
});

test("toOpenAIMessages pairs a tool message missing an id with the previous assistant call", () => {
  const out = toOpenAIMessages([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_abc", type: "function", function: { name: "Read", arguments: "{}" } }],
    },
    { role: "tool", content: '{"huge":true}' },
  ]);
  assert.equal(out[2]?.role, "tool");
  assert.equal(out[2]?.tool_call_id, "call_abc");
  assert.equal("toolCallId" in (out[2] ?? {}), false);
});

test("toOpenAIMessages converts AI SDK tool-call and tool-result parts", () => {
  const out = toOpenAIMessages([
    { role: "user", content: [{ type: "text", text: "search" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        { type: "tool-call", toolCallId: "call_def", toolName: "Grep", args: { q: "x" } },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_def", result: { hits: 1 } }],
    },
  ]);
  assert.equal(out[1]?.role, "assistant");
  assert.equal(out[1]?.content, "looking");
  assert.equal(out[1]?.tool_calls?.[0]?.id, "call_def");
  assert.equal(out[1]?.tool_calls?.[0]?.function.name, "Grep");
  assert.equal(out[1]?.tool_calls?.[0]?.function.arguments, '{"q":"x"}');
  assert.equal(out[2]?.role, "tool");
  assert.equal(out[2]?.tool_call_id, "call_def");
  assert.equal(out[2]?.content, '{"hits":1}');
});

test("toOpenAIMessages keeps an already-valid OpenAI tool turn", () => {
  const src = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "x", type: "function", function: { name: "Read", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "x", content: "ok" },
  ];
  const out = toOpenAIMessages(src);
  assert.equal(out[2]?.tool_call_id, "x");
  assert.equal(out[1]?.tool_calls?.[0]?.id, "x");
});

test("toOpenAIMessages uses a synthetic id when no assistant call exists", () => {
  const out = toOpenAIMessages([{ role: "tool", content: "orphan" }]);
  assert.equal(out[0]?.role, "tool");
  assert.equal(typeof out[0]?.tool_call_id, "string");
  assert.ok((out[0]?.tool_call_id ?? "").length > 0);
});
