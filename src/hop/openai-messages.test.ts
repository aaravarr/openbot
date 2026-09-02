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

test("toOpenAIMessages never inserts a system_reminder of its own", () => {
  const out = toOpenAIMessages([{ role: "user", content: "你看看" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.content, "你看看");
  assert.equal((out[0]?.content ?? "").includes("system_reminder"), false);
  assert.equal((out[0]?.content ?? "").includes("Acknowledge them RIGHT NOW"), false);
});

test("toOpenAIMessages keeps host system_reminder text verbatim", () => {
  const content =
    "<timestamp>Wednesday, Sep 2, 2026, 3:35 PM (UTC+8)</timestamp>\n<user_query>\n[t1u]\n你看看\n\n<system_reminder>\nYou opened this turn by calling tools without first acknowledging the user\n</system_reminder>\n</user_query>";
  const out = toOpenAIMessages([{ role: "user", content }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.role, "user");
  assert.equal(out[0]?.content, content);
});

test("toOpenAIMessages keeps a user turn that is only a host reminder", () => {
  const reminder =
    "<system_reminder>\nYou opened this turn by calling tools without first acknowledging the user, so they are watching silence\n</system_reminder>";
  const out = toOpenAIMessages([
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "user", content: reminder },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[2]?.role, "user");
  assert.equal(out[2]?.content, reminder);
  assert.equal(out[1]?.role, "tool");
});

test("toOpenAIMessages keeps host ack-redrive recovery prompts", () => {
  const keepMe = "keep me";
  const redrive =
    "<timestamp>Wednesday, Sep 2, 2026, 3:37 PM (UTC+8)</timestamp>\n<user_query>\n[SAND_HIDDEN_PROMPT][ack-redrive-1f661e5f-9e4c-4e49-863a-180a41fae668]\n[System recovery] The user sent one or more messages\n</user_query>";
  const out = toOpenAIMessages([
    { role: "user", content: keepMe },
    { role: "user", content: redrive },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.content, keepMe);
  assert.equal(out[1]?.content, redrive);
});

test("toOpenAIMessages keeps a SAND_HIDDEN_PROMPT delivery nudge verbatim", () => {
  const nudge =
    "[SAND_HIDDEN_PROMPT] Your previous turn left the user without the result they're waiting on — you never called SendToUser. Invoke SendToUser now with the result.";
  const out = toOpenAIMessages([{ role: "user", content: nudge }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.role, "user");
  assert.equal(out[0]?.content, nudge);
});

test("toOpenAIMessages keeps host reminder text inside array text parts", () => {
  const text =
    "<system_reminder>\nAcknowledge them RIGHT NOW\n</system_reminder>";
  const out = toOpenAIMessages([
    { role: "user", content: [{ type: "text", text }] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.content, text);
});
