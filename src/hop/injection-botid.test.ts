import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

/**
 * Identity-observation contract for the delivery-follow-up strategy.
 *
 * Production evidence (2026-09, box /home/box/agent-data): every hop row
 * reported skipReason "no_bot_id" while the paired rows carried a top-level
 * botId - the observable context was simply never extracted. These tests pin
 * the two halves of the fix:
 *
 * 1. the hop-side observed context now carries the same botId/chatType the
 *    request log extracts (system-prompt profile path / <user_query> header),
 *    so an untrusted-but-present id reports honest eligibility instead of a
 *    blanket no_bot_id, and
 * 2. a trusted host context that lacks identity fails with a precise
 *    trusted_context_missing_* reason - trust never borrows observable data
 *    and an empty trusted envelope is not mislabeled as "no id in request".
 */

const hop = require("../../payload/hop-handler.cjs") as {
  injectionObservedContextForTests: (req: unknown, body: unknown, conversationId: string) => unknown;
};
const hardening = require("../../payload/injection-hardening.cjs") as {
  contextFromRequest: (req: unknown, body: unknown, observed: unknown) => unknown;
  personOpenedPermission: (input: unknown, options?: { requireEpoch?: boolean }) => {
    eligible: boolean;
    identityGate: string;
    skipReason?: string;
    source: string;
    uncertain: boolean;
    botId?: string;
    conversationId?: string;
    epochId?: string;
  };
};

const BOT_ID = "b8783b54-0ab5-42ec-ac3b-3c838bc528bd";

/** System prompt exactly as the custom wrap forwards it from the host. */
function systemPrompt(botId: string) {
  return "You are the assistant. Profile: /home/box/agent-data/agents/" + botId + "/profile.json";
}

test("observed context extracts botId from the host system prompt path", () => {
  const context = hop.injectionObservedContextForTests(
    { headers: {} },
    { model: "m", messages: [{ role: "system", content: systemPrompt(BOT_ID) }] },
    "",
  ) as { hostContext?: unknown; observed: { botId: string; chatType: string } };
  assert.equal(context.hostContext, undefined, "no trusted channel is present on the plain hop path");
  assert.equal(context.observed.botId, BOT_ID, "botId mirrors the request-log extraction contract");
});

test("observed context extracts chatType from the <user_query> transcript header", () => {
  const context = hop.injectionObservedContextForTests(
    { headers: {} },
    {
      model: "m",
      messages: [
        { role: "system", content: systemPrompt(BOT_ID) },
        { role: "user", content: "<user_query>[Group chat: \"Family\"] hello</user_query>" },
      ],
    },
    "",
  ) as { observed: { botId: string; chatType: string } };
  assert.equal(context.observed.botId, BOT_ID);
  assert.equal(context.observed.chatType, "group");
});

test("no id anywhere keeps the honest no_bot_id_in_request skip reason", () => {
  const context = hop.injectionObservedContextForTests({ headers: {} }, { model: "m", messages: [{ role: "user", content: "hi" }] }, "");
  const permission = hardening.personOpenedPermission(context, { requireEpoch: false });
  assert.equal(permission.eligible, false);
  assert.equal(permission.skipReason, "no_bot_id_in_request");
  assert.equal(permission.source, "observable-fallback");
});

test("extracted id with dm chat type passes the uncertain observable fallback", () => {
  const context = hop.injectionObservedContextForTests(
    { headers: {} },
    {
      model: "m",
      messages: [
        { role: "system", content: systemPrompt(BOT_ID) },
        { role: "user", content: "<user_query>please do the thing</user_query>" },
      ],
    },
    "conversation-1",
  );
  const permission = hardening.personOpenedPermission(context, { requireEpoch: false });
  assert.equal(permission.eligible, true, "observable identity now gates honestly instead of no_bot_id");
  assert.equal(permission.identityGate, "pass");
  assert.equal(permission.source, "observable-fallback");
  assert.equal(permission.uncertain, true, "observable identity stays uncertain by design");
  assert.equal(permission.botId, BOT_ID);
});

test("group transcript stays skipped with the explicit group_chat reason", () => {
  const context = hop.injectionObservedContextForTests(
    { headers: {} },
    {
      model: "m",
      messages: [
        { role: "system", content: systemPrompt(BOT_ID) },
        { role: "user", content: "<user_query>[Group chat: \"Family\"] hello</user_query>" },
      ],
    },
    "conversation-1",
  );
  const permission = hardening.personOpenedPermission(context, { requireEpoch: false });
  assert.equal(permission.eligible, false);
  assert.equal(permission.skipReason, "group_chat");
});

test("a trusted context missing identity fails with the precise trusted reason", () => {
  const context = hardening.contextFromRequest(
    {
      openbotHostContext: {
        botId: "",
        conversationId: "conversation-1",
        epochId: "epoch-1",
        hidden: false,
        requestSource: "person",
        isSubagent: false,
        isSilenceAllowed: false,
        isRoutine: false,
        chatType: "dm",
        groupFlag: false,
        isGroupMemberTurn: false,
      },
    },
    { botId: BOT_ID, messages: [{ role: "system", content: systemPrompt(BOT_ID) }] },
    { botId: BOT_ID, conversationId: "conversation-1" },
  );
  const permission = hardening.personOpenedPermission(context, { requireEpoch: true });
  assert.equal(permission.eligible, false, "empty trusted botId never borrows the observable id");
  assert.equal(permission.skipReason, "trusted_context_missing_bot_id");
  assert.equal(permission.source, "authenticated-host");
  assert.equal(permission.uncertain, false);
});

test("a trusted context missing conversation id reports trusted_context_missing_conversation_id", () => {
  const context = hardening.contextFromRequest(
    {
      openbotHostContext: {
        botId: "bot-1",
        conversationId: "",
        epochId: "epoch-1",
        hidden: false,
        requestSource: "person",
        isSubagent: false,
        isSilenceAllowed: false,
        isRoutine: false,
        chatType: "dm",
        groupFlag: false,
        isGroupMemberTurn: false,
      },
    },
    { conversationId: "conversation-1" },
    { conversationId: "conversation-1" },
  );
  const permission = hardening.personOpenedPermission(context, { requireEpoch: true });
  assert.equal(permission.eligible, false);
  assert.equal(permission.skipReason, "trusted_context_missing_conversation_id");
});

test("a fully trusted person context still passes with its own identity", () => {
  const context = hardening.contextFromRequest(
    {
      openbotHostContext: {
        botId: "bot-1",
        conversationId: "conversation-1",
        epochId: "epoch-1",
        hidden: false,
        requestSource: "person",
        isSubagent: false,
        isSilenceAllowed: false,
        isRoutine: false,
        chatType: "dm",
        groupFlag: false,
        isGroupMemberTurn: false,
      },
    },
    {},
    {},
  );
  const permission = hardening.personOpenedPermission(context, { requireEpoch: true });
  assert.equal(permission.eligible, true);
  assert.equal(permission.identityGate, "pass");
  assert.equal(permission.source, "authenticated-host");
  assert.equal(permission.botId, "bot-1");
});
