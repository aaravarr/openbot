import assert from "node:assert/strict";
import test from "node:test";
import { extractChatContext } from "./extract-chat-context.ts";

const identity = {
  role: "system",
  content: 'Your agent name is "测试".\nYour profile is /home/box/agent-data/agents/1cf5a3e0-2623-468c-ba97-6b14f8f3c12a/profile.json',
};

test("extracts bot identity and the last group chat", () => {
  const result = extractChatContext([
    identity,
    { role: "user", content: '<user_query>\n[Group chat: "旧群" - with 人事管理]\nhello' },
    { role: "user", content: '<user_query>\n[Group chat: "测试群聊" - with 人事管理]\nhello' },
  ]);
  assert.deepEqual(result, { botId: "1cf5a3e0-2623-468c-ba97-6b14f8f3c12a", botName: "测试", chatType: "group", chatName: "测试群聊" });
});

test("classifies a normal tagged user query as a direct message", () => {
  assert.deepEqual(extractChatContext([identity, { role: "user", content: "<user_query>\n[t4u] hello" }]), {
    botId: "1cf5a3e0-2623-468c-ba97-6b14f8f3c12a",
    botName: "测试",
    chatType: "dm",
  });
});

test("extracts bot identity from a user profile message", () => {
  assert.deepEqual(extractChatContext([
    { role: "system", content: "You are Grok Bot." },
    { role: "user", content: 'Your agent name is "小红书-文案".\n/home/box/agent-data/agents/1cf5a3e0-2623-468c-ba97-6b14f8f3c12a/profile.json\n<user_query>\nhello' },
  ]), {
    botId: "1cf5a3e0-2623-468c-ba97-6b14f8f3c12a",
    botName: "小红书-文案",
    chatType: "dm",
  });
});

test("extracts bot identity from a system profile message", () => {
  assert.deepEqual(extractChatContext([identity]), {
    botId: "1cf5a3e0-2623-468c-ba97-6b14f8f3c12a",
    botName: "测试",
  });
});

test("leaves bot identity absent when no profile is present", () => {
  assert.deepEqual(extractChatContext([{ role: "system", content: "You are Grok Bot." }]), {});
});

test("marks routine wakeups without throwing on missing fields", () => {
  assert.deepEqual(extractChatContext([{ role: "user", content: "<user_query>\n[routine]\n<system_reminder>run</system_reminder>" }]), { chatType: "routine" });
  assert.deepEqual(extractChatContext([{ role: "assistant", content: "not a user message" }]), {});
});

test("uses the last matching user message and tolerates structured content", () => {
  const result = extractChatContext([
    identity,
    { role: "user", content: [{ type: "text", text: '<user_query>\n[Group chat: "first"]' }] },
    { role: "user", content: [{ type: "text", text: "<user_query>\n[t4u] later" }] },
  ]);
  assert.equal(result.chatType, "dm");
  assert.equal(result.chatName, undefined);
});

test("extracts unquoted identity variants and supports profile fallback", () => {
  const messages = [
    {
      role: "system",
      content: "Your agent name is 人事管理\nprofile: /home/box/agent-data/agents/1cf5a3e0-2623-468c-ba97-6b14f8f3c12a/profile.json",
    },
    { role: "user", content: "<user_query>\nhello" },
  ];
  assert.equal(extractChatContext(messages).botName, "人事管理");
  assert.equal(extractChatContext([
    { role: "system", content: "profile: /home/box/agent-data/agents/1cf5a3e0-2623-468c-ba97-6b14f8f3c12a/profile.json" },
    { role: "user", content: "<user_query>\nhello" },
  ], { resolveBotName: () => "回填名称" }).botName, "回填名称");
});
