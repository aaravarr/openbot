import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const modulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/injection-hardening.cjs");
const hardening: any = require(modulePath);

const CONFIG = {
  mode: "enforce",
  l1: { enabled: false },
  l2: {
    enabled: true,
    maxAdditionalRuns: 1,
    terminalDecisionTimeoutMs: 250,
    retryBudgetMs: 15000,
    timeoutMs: 15000,
    maxAdditionalPromptTokens: 131072,
    maxAdditionalCompletionTokens: 2048,
    maxAdditionalCostUsd: 10,
  },
  l3: { enabled: true, maxRedrivesPerEpoch: 1, ttlMs: 300000 },
};

function context(epoch = "epoch-1") {
  return {
    hostContext: {
      trusted: true,
      botId: "bot-1",
      conversationId: "conversation-1",
      epochId: epoch,
      hidden: false,
      requestSource: "person",
      isSubagent: false,
      isSilenceAllowed: false,
      isRoutine: false,
      chatType: "dm",
      groupFlag: false,
      isGroupMemberTurn: false,
    },
  };
}

function silentObservation() {
  const observation = hardening.createObservation();
  hardening.observeChatEvent(observation, {
    choices: [{ delta: { content: "plain result" }, finish_reason: null }],
  }, "data: text\n\n");
  hardening.observeChatEvent(observation, {
    choices: [{ delta: {}, finish_reason: "stop" }],
  }, "data: terminal\n\n");
  observation.terminalEvents.push({ sequence: 1, finishReason: "stop", bytes: 20 });
  hardening.finalizeObservation(observation, true);
  return observation;
}

function toolObservation(name = "Read") {
  const observation = hardening.createObservation();
  hardening.observeChatEvent(observation, {
    choices: [{ delta: { tool_calls: [{ index: 0, id: "call-current", type: "function", function: { name, arguments: "{}" } }] }, finish_reason: null }],
  }, "data: tool\n\n");
  hardening.observeChatEvent(observation, {
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
  }, "data: terminal\n\n");
  observation.terminalEvents.push({ sequence: 1, finishReason: "tool_calls", bytes: 20 });
  hardening.finalizeObservation(observation, true);
  return observation;
}

function terminalHold(observation: any) {
  const replayed: Buffer[] = [];
  const hold = hardening.createTerminalHold((bytes: Buffer) => replayed.push(Buffer.from(bytes)), observation);
  hold.hold(Buffer.from("original-terminal"));
  return { hold, replayed };
}

function secondResult(observation: any, withDelivery = true) {
  const bytes: Buffer[] = [];
  const hold = hardening.createTerminalHold((chunk: Buffer) => bytes.push(Buffer.from(chunk)), observation);
  hold.hold(Buffer.from("second-terminal"));
  return { ok: true, observation, heldTerminal: hold, hasValidTerminal: true, bytes };
}

function assistantCall(name: string, id: string) {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  };
}

function runOptions(messages: any[], observation = silentObservation()) {
  const { hold, replayed } = terminalHold(observation);
  return {
    options: {
      config: CONFIG,
      context: context(),
      messages,
      observation,
      heldTerminal: hold,
      stateKey: "conversation-1\0bot-1\0epoch-1",
      injection: hardening.applyPreGeneration(messages, { config: CONFIG, context: context() }).injection,
    },
    hold,
    replayed,
  };
}

test("exact official nudge bodies and hidden marker are preserved", () => {
  assert.equal(
    hardening.buildNudgeMessages([{ role: "user", content: "hello" }], "no-touch").at(-1).content,
    hardening.HIDDEN_MARKER + hardening.REPLY_NUDGE_PROMPT,
  );
  assert.equal(
    hardening.buildNudgeMessages([{ role: "user", content: "hello" }], "touch-then-tool").at(-1).content,
    hardening.HIDDEN_MARKER + hardening.CLOSING_SEND_PROMPT,
  );
});

test("latest-user classifier selects no-touch, touch-then-tool, and touch-no-tool", () => {
  const noTouch = hardening.classifyDebt({ messages: [{ role: "user", id: "u1", content: "work" }] });
  assert.deepEqual({ state: noTouch.debtState, shape: noTouch.debtShape }, { state: "owed", shape: "no-touch" });

  const touchedThenTool = hardening.classifyDebt({
    messages: [
      { role: "user", id: "u1", content: "work" },
      assistantCall("SendToUser", "delivery-1"),
      { role: "tool", tool_call_id: "delivery-1", content: "sent" },
      assistantCall("Read", "read-1"),
    ],
  });
  assert.deepEqual({ state: touchedThenTool.debtState, shape: touchedThenTool.debtShape }, { state: "owed", shape: "touch-then-tool" });

  const touchedNoTool = hardening.classifyDebt({
    messages: [
      { role: "user", id: "u1", content: "work" },
      assistantCall("ReactToMessage", "reaction-1"),
    ],
  });
  assert.deepEqual({ state: touchedNoTool.debtState, shape: touchedNoTool.debtShape }, { state: "not-owed", shape: "touch-no-tool" });
});

test("no-touch silent stop runs one §3.27 remediation with exact suffix", async () => {
  hardening.resetForTests();
  const fixture = runOptions([{ role: "user", id: "u1", content: "work" }]);
  let calls = 0;
  const result = await hardening.runL2({
    ...fixture.options,
    runSecond: async ({ messages }: any) => {
      calls += 1;
      assert.equal(messages.at(-1).content, hardening.HIDDEN_MARKER + hardening.REPLY_NUDGE_PROMPT);
      return secondResult(silentObservation());
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.injection.l2AdditionalRuns, 1);
  assert.equal(result.injection.l2Outcome, "valid-no-tool");
  assert.equal(result.injection.finalNoTool, true);
  assert.equal(fixture.hold.bytes(), 0);
  assert.deepEqual(fixture.replayed, []);
});

test("touch then tool silent stop runs one §3.28 remediation", async () => {
  hardening.resetForTests();
  const fixture = runOptions([
    { role: "user", id: "u1", content: "work" },
    assistantCall("SendToUser", "delivery-1"),
    { role: "tool", tool_call_id: "delivery-1", content: "ack" },
    assistantCall("Read", "read-1"),
  ]);
  let calls = 0;
  const result = await hardening.runL2({
    ...fixture.options,
    runSecond: async ({ messages }: any) => {
      calls += 1;
      assert.equal(messages.at(-1).content, hardening.HIDDEN_MARKER + hardening.CLOSING_SEND_PROMPT);
      return secondResult(toolObservation("SendToUser"));
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.injection.l2Outcome, "call-emitted");
  assert.equal(result.injection.l2NudgeShape, "touch-then-tool");
  assert.equal(fixture.hold.bytes(), 0);
});

test("touch with no later tool is not owed and is released immediately", async () => {
  hardening.resetForTests();
  const fixture = runOptions([
    { role: "user", id: "u1", content: "work" },
    assistantCall("SendToUser", "delivery-1"),
  ]);
  let calls = 0;
  const result = await hardening.runL2({ ...fixture.options, runSecond: async () => { calls += 1; return secondResult(silentObservation()); } });
  assert.equal(calls, 0);
  assert.equal(result.injection.l2Outcome, "not-eligible");
  assert.equal(result.injection.skipReason, "debt_not_owed");
  assert.equal(fixture.replayed.length, 1);
  assert.equal(fixture.hold.bytes(), 0);
});

test("current response tool call is non-silent and releases without remediation", async () => {
  hardening.resetForTests();
  const fixture = runOptions([{ role: "user", id: "u1", content: "work" }], toolObservation());
  let calls = 0;
  const result = await hardening.runL2({ ...fixture.options, runSecond: async () => { calls += 1; return secondResult(silentObservation()); } });
  assert.equal(calls, 0);
  assert.equal(result.injection.skipReason, "response_has_tool_calls");
  assert.equal(result.injection.l2AdditionalRuns, 0);
  assert.equal(fixture.replayed.length, 1);
});

test("second silent stop is unresolved and never starts a third run", async () => {
  hardening.resetForTests();
  const fixture = runOptions([{ role: "user", id: "u1", content: "work" }]);
  let calls = 0;
  const first = await hardening.runL2({
    ...fixture.options,
    runSecond: async () => { calls += 1; return secondResult(silentObservation()); },
  });
  assert.equal(calls, 1);
  assert.equal(first.injection.finalNoTool, true);

  const next = runOptions([{ role: "user", id: "u1", content: "work" }]);
  const second = await hardening.runL2({
    ...next.options,
    runSecond: async () => { calls += 1; return secondResult(silentObservation()); },
  });
  assert.equal(calls, 1);
  assert.equal(second.injection.skipReason, "l2_attempt_exhausted");
  assert.equal(second.injection.finalNoTool, true);
  assert.equal(next.replayed.length, 1);
});

test("all second-run failures replay the original terminal exactly once", async () => {
  for (const shapeMessages of [
    [{ role: "user", id: "u1", content: "work" }],
    [{ role: "user", id: "u1", content: "work" }, assistantCall("SendToUser", "delivery-1"), { role: "tool", tool_call_id: "delivery-1", content: "ack" }, assistantCall("Read", "read-1")],
  ]) {
    hardening.resetForTests();
    const fixture = runOptions(shapeMessages);
    const result = await hardening.runL2({
      ...fixture.options,
      runSecond: async () => { throw new Error("upstream 502"); },
    });
    assert.equal(result.injection.l2Outcome, "failed-first-fallback");
    assert.equal(fixture.replayed.length, 1);
    assert.equal(fixture.replayed[0]?.toString(), "original-terminal");
    assert.equal(fixture.hold.bytes(), 0);
  }
});

test("budget refusal, lease contention, and client abort all release a held terminal", async () => {
  hardening.resetForTests();
  const budget = runOptions([{ role: "user", id: "u1", content: "work" }]);
  const budgetResult = await hardening.runL2({ ...budget.options, config: { ...CONFIG, l2: { ...CONFIG.l2, maxAdditionalPromptTokens: 8192 } }, promptTokensEstimated: 9000, runSecond: async () => secondResult(silentObservation()) });
  assert.equal(budgetResult.injection.skipReason, "budget_prompt");
  assert.equal(budget.replayed.length, 1);

  hardening.resetForTests();
  const heldLease = hardening.acquireLease("conversation-1\0bot-1\0epoch-1");
  const busy = runOptions([{ role: "user", id: "u1", content: "work" }]);
  const busyResult = await hardening.runL2({ ...busy.options, runSecond: async () => secondResult(silentObservation()) });
  assert.equal(busyResult.injection.skipReason, "lease_busy");
  assert.equal(busy.replayed.length, 1);
  hardening.releaseLease(heldLease);

  hardening.resetForTests();
  const aborted = runOptions([{ role: "user", id: "u1", content: "work" }]);
  const controller = new AbortController();
  const abortResult = await hardening.runL2({ ...aborted.options, signal: controller.signal, runSecond: async () => { controller.abort(); throw new Error("client_closed"); } });
  assert.equal(abortResult.injection.l2Outcome, "failed-first-fallback");
  assert.equal(aborted.replayed.length, 1);
});

test("off mode returns canonical messages unchanged and emits no metadata", () => {
  const messages = [{ role: "user", content: "hello" }];
  const result = hardening.applyPreGeneration(messages, { config: { mode: "off" }, context: context() });
  assert.equal(result.messages, messages);
  assert.equal(result.injection, undefined);
});

test("L1 reply-first is suffix-only and never runs inside structural conversion", () => {
  hardening.resetForTests();
  const result = hardening.applyPreGeneration([{ role: "user", content: "hello" }], {
    config: { ...CONFIG, l1: { enabled: true } },
    context: context(),
    opening: true,
  });
  assert.equal(result.messages[0].content, "hello" + hardening.REPLY_FIRST_REMINDER);
  assert.equal(result.injection.family, "l1.reply-first");
  assert.equal(result.injection.injectionApplied, true);
});

test("an image-heavy canonical context is not budgeted as if base64 were text", async () => {
  hardening.resetForTests();
  // The production body (2026-09-14): 1773603 bytes of canonical messages that
  // are mostly ONE inline image plus a short transcript. A bytes/4 walk read it
  // as ~443K tokens against maxAdditionalPromptTokens 131072, so every silent
  // turn skipReason'd as budget_prompt and L2 never ran; the real prompt was
  // ~85K tokens.
  const image = "data:image/png;base64," + "A".repeat(1_600_000);
  const messages = [
    { role: "system", content: "You are the assistant. Profile: /home/box/agent-data/agents/bot/profile.json" },
    { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image_url", image_url: { url: image } }] },
  ];
  const fixture = runOptions(messages);
  let calls = 0;
  const result = await hardening.runL2({
    ...fixture.options,
    runSecond: async () => { calls += 1; return secondResult(silentObservation()); },
  });
  assert.equal(calls, 1, "the image does not trip the prompt reservation");
  assert.equal(result.injection.skipReason, undefined);
  const estimated = result.injection.l2PromptTokensEstimated as number;
  assert.ok(estimated >= 1600, "the image is charged a flat per-image cost: " + String(estimated));
  assert.ok(estimated < 8192, "and never its base64 byte weight: " + String(estimated));
});

test("a genuinely oversized TEXT context still trips the prompt reservation", async () => {
  hardening.resetForTests();
  const messages = [{ role: "user", content: "x".repeat(600_000) }];
  const fixture = runOptions(messages);
  let calls = 0;
  const result = await hardening.runL2({
    ...fixture.options,
    runSecond: async () => { calls += 1; return secondResult(silentObservation()); },
  });
  assert.equal(calls, 0);
  assert.equal(result.injection.skipReason, "budget_prompt");
  assert.ok((result.injection.l2PromptTokensEstimated as number) > 131072);
  assert.equal(fixture.replayed.length, 1, "the held terminal is still released");
});

test("the L2 deadline default covers a real upstream turn and is not clamped to 30 s", () => {
  assert.equal((hardening.DEFAULT_CONFIG.l2 as any).timeoutMs, 120000);
  const defaults = hardening.normalizeConfig({ mode: "enforce", layers: { l2: { enabled: true } } });
  // The observed upstream worst case on the box was 59196 ms total (first token
  // 53049 ms); the old 15000 ms default -- and the 30000 ms acceptance ceiling --
  // timed every remediation run out into failed-first-fallback.
  assert.equal(defaults.l2.timeoutMs, 120000);
  assert.equal(defaults.l2.retryBudgetMs, 120000);
  const explicit = hardening.normalizeConfig({ mode: "enforce", layers: { l2: { enabled: true, timeoutMs: 180000 } } });
  assert.equal(explicit.l2.timeoutMs, 180000, "an explicit deadline above the old ceiling survives normalization");
  assert.equal(explicit.l2.retryBudgetMs, 180000);
  const retryBudget = hardening.normalizeConfig({ mode: "enforce", layers: { l2: { enabled: true, retryBudgetMs: 240000 } } });
  assert.equal(retryBudget.l2.timeoutMs, 120000, "a retry ceiling alone never raises the deadline past the default");
  const both = hardening.normalizeConfig({ mode: "enforce", layers: { l2: { enabled: true, timeoutMs: 240000, retryBudgetMs: 240000 } } });
  assert.equal(both.l2.timeoutMs, 240000, "both names can raise the hard deadline together");
  const capped = hardening.normalizeConfig({ mode: "enforce", layers: { l2: { enabled: true, timeoutMs: 240000, retryBudgetMs: 60000 } } });
  assert.equal(capped.l2.timeoutMs, 60000, "the retry ceiling still caps the deadline");
  const tooBig = hardening.normalizeConfig({ mode: "enforce", layers: { l2: { enabled: true, timeoutMs: 600001 } } });
  assert.equal(tooBig.l2.timeoutMs, 120000, "out of range falls back to the default, never clamps silently");
  const promptCeiling = hardening.normalizeConfig({ mode: "enforce", layers: { l2: { enabled: true, maxAdditionalPromptTokens: 1048576 } } });
  assert.equal(promptCeiling.l2.maxAdditionalPromptTokens, 1048576, "a 1M-context model can be budgeted for");
});

test("a silent stop L2 cannot act on still arms L3 for the next request", async () => {
  hardening.resetForTests();
  const nextMessages = [{ role: "user", id: "u1", content: "work" }];
  // Touch-no-tool: silent stop, but not owed -- L2 releases without a second
  // run. That release MUST record the silent verdict, because the hold path
  // never reaches rememberResponse and L3's only precondition is that verdict.
  const before = hardening.applyPreGeneration(nextMessages, { config: CONFIG, context: context() });
  assert.equal(before.injection.injectionApplied, undefined, "nothing is armed before the silent response");

  const fixture = runOptions([{ role: "user", id: "u1", content: "work" }, assistantCall("SendToUser", "delivery-1")]);
  const result = await hardening.runL2({ ...fixture.options, runSecond: async () => secondResult(silentObservation()) });
  assert.equal(result.injection.skipReason, "debt_not_owed");
  assert.equal(result.injection.l2Outcome, "not-eligible");

  const redrive = hardening.applyPreGeneration(nextMessages, { config: CONFIG, context: context() });
  assert.equal(redrive.injection.family, "l3.reply-nudge");
  assert.equal(redrive.injection.injectionApplied, true);
  assert.equal(redrive.messages.at(-1).content, hardening.HIDDEN_MARKER + hardening.REPLY_NUDGE_PROMPT);
});

test("a later non-silent response in the same epoch disarms L3 again", async () => {
  hardening.resetForTests();
  const arm = runOptions([{ role: "user", id: "u1", content: "work" }, assistantCall("SendToUser", "delivery-1")]);
  await hardening.runL2({ ...arm.options, runSecond: async () => secondResult(silentObservation()) });
  // Same epoch, but this response carried a tool call: the turn continues, so
  // the stale arm must be cleared instead of driving a redrive later.
  const clear = runOptions([{ role: "user", id: "u1", content: "work" }], toolObservation());
  const cleared = await hardening.runL2({ ...clear.options, runSecond: async () => secondResult(silentObservation()) });
  assert.equal(cleared.injection.skipReason, "response_has_tool_calls");
  const after = hardening.applyPreGeneration([{ role: "user", id: "u1", content: "work" }], { config: CONFIG, context: context() });
  assert.equal(after.injection.injectionApplied, undefined, "no redrive after a non-silent response");
});

test("the second run never stacks a second copy of the same hidden nudge", async () => {
  hardening.resetForTests();
  // The L3 pre-generation redrive already appended this exact nudge to the
  // request; the in-request L2 remediation must reuse it, not repeat it.
  const messages = [
    { role: "user", id: "u1", content: "work" },
    { role: "user", content: hardening.HIDDEN_MARKER + hardening.REPLY_NUDGE_PROMPT },
  ];
  const fixture = runOptions(messages);
  let sent: any[] = [];
  const result = await hardening.runL2({
    ...fixture.options,
    runSecond: async ({ messages: secondMessages }: any) => {
      sent = secondMessages;
      return secondResult(silentObservation());
    },
  });
  assert.equal((sent.at(-1) as any).content, hardening.HIDDEN_MARKER + hardening.REPLY_NUDGE_PROMPT);
  assert.equal(sent.length, messages.length, "no duplicate nudge row");
  assert.equal(result.injection.l2NudgeShape, "no-touch");
});
