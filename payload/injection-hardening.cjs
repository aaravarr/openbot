"use strict";

// Injection hardening is deliberately a named, opt-in policy.  The host
// transcript converter remains structural; this module runs only after that
// conversion and before provider serialization.
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var HIDDEN_MARKER = "[SAND_HIDDEN_PROMPT]";
var TEMPLATE_VERSION = "2026-09-11";
var DELIVERY_NAMES = { SendToUser: true, SendMessage: true, ReactToMessage: true };
var TEXT_DELIVERY_NAMES = { SendToUser: true, SendMessage: true };

var REPLY_NUDGE_PROMPT = "Your previous turn left the user without the result they're waiting on — you never called SendToUser that turn, or every SendToUser you tried failed to deliver. Either way they received nothing and are still waiting. Do not assume a send from an earlier turn covered it: an opening acknowledgement back then did not deliver this result (ack ≠ delivery). Deliver the result now by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them, so if you don't call the tool they just keep seeing silence.";
var CLOSING_SEND_PROMPT = "Your previous turn acknowledged the user and then ran tool calls, but ended without a follow-up SendToUser — the last thing the user saw is that opening acknowledgement, so whatever the tool calls produced after it never reached them. If that work produced the result or answer they are waiting on, deliver it now by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them. If the work is genuinely unfinished, continue it and send the result once you have it.";
var REPLY_FIRST_BODY = "Reply to this message by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER delivered; only a real SendToUser tool invocation reaches the user, so if you don't invoke the tool they just see silence.";
var REPLY_FIRST_REMINDER = "<system_reminder>\n" + REPLY_FIRST_BODY + "\n</system_reminder>";
var START_ACK_REMINDER = "<system_reminder>\nYou opened this turn by calling tools without first acknowledging the user, so they are watching silence and may think the app froze. Acknowledge them RIGHT NOW by actually invoking the SendToUser tool — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them, so if you don't call the tool they just keep seeing silence. Make that first SendToUser a one-line text acknowledgement, before any further tool call, then continue the work. A widget, attachment, or cursor-agent card does not count as this acknowledgement.\n</system_reminder>";
var WATCHING_SILENCE_REMINDER = "<system_reminder>\nYou have made several tool calls without a SendToUser, so the user is currently watching silence. Actually invoke the SendToUser tool now — make a real tool/function call, not text you write. Plain assistant text is NEVER shown to the user; only a real SendToUser tool invocation reaches them, so if you don't call the tool they just keep seeing silence. Send a brief, specific update on what you are doing or what you just found before continuing.\n</system_reminder>";
var EARLY_RESULT_REMINDER = "<system_reminder>\nRemember: the user cannot see tool output or your thinking — only SendToUser reaches them. If you have produced a result or finished what they asked, send it now with a SendToUser tool call before continuing or ending the turn. If you are still mid-task, keep working and send the result once you have it.\n</system_reminder>";

var DEFAULT_CONFIG = {
  mode: "off",
  l1: {
    enabled: false,
    startOfTurnAckThreshold: 1,
    watchingSilenceThreshold: 6,
    earlyResultThreshold: 0,
  },
  l2: {
    enabled: false,
    maxAdditionalRuns: 1,
    terminalDecisionTimeoutMs: 250,
    retryBudgetMs: 15000,
    timeoutMs: 15000,
    maxAdditionalPromptTokens: 131072,
    maxAdditionalCompletionTokens: 2048,
    maxAdditionalCostUsd: 0.10,
  },
  l3: {
    enabled: false,
    maxRedrivesPerEpoch: 1,
    ttlMs: 300000,
  },
};

var epochStates = new Map();
var terminalLeases = new Map();

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  var n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function intIn(value, min, max, fallback) {
  var n = finiteNumber(value);
  if (n === undefined || !Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function numberIn(value, min, max, fallback) {
  var n = finiteNumber(value);
  if (n === undefined || n < min || n > max) return fallback;
  return n;
}

function boolValue(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function injectionPath() {
  if (process.env.OPENBOT_INJECTION) return process.env.OPENBOT_INJECTION;
  if (process.env.OPENBOT_SAND_DATA) return path.join(process.env.OPENBOT_SAND_DATA, "openbot-injection.json");
  if (process.env.OPENBOT_PLAN) return path.join(path.dirname(process.env.OPENBOT_PLAN), "openbot-injection.json");
  return "/home/box/sand-data/openbot-injection.json";
}

function layerSource(raw, name) {
  if (!isRecord(raw)) return undefined;
  if (isRecord(raw[name])) return raw[name];
  if (isRecord(raw.layers) && isRecord(raw.layers[name])) return raw.layers[name];
  return undefined;
}

function normalizeConfig(raw) {
  if (!isRecord(raw)) return cloneConfig(DEFAULT_CONFIG);
  var mode = raw.mode;
  if (mode !== "off" && mode !== "dry-run" && mode !== "enforce") mode = "off";
  var l1Raw = layerSource(raw, "l1");
  var l2Raw = layerSource(raw, "l2");
  var l3Raw = layerSource(raw, "l3");
  var out = {
    mode: mode,
    l1: {
      enabled: l1Raw ? boolValue(l1Raw.enabled, true) : false,
      startOfTurnAckThreshold: intIn(l1Raw && l1Raw.startOfTurnAckThreshold, 1, 1000000, 1),
      watchingSilenceThreshold: intIn(l1Raw && l1Raw.watchingSilenceThreshold, 1, 1000000, 6),
      earlyResultThreshold: intIn(l1Raw && l1Raw.earlyResultThreshold, 0, 1000000, 0),
    },
    l2: {
      enabled: l2Raw ? boolValue(l2Raw.enabled, true) : false,
      maxAdditionalRuns: intIn(l2Raw && l2Raw.maxAdditionalRuns, 0, 1, 1),
      terminalDecisionTimeoutMs: intIn(l2Raw && l2Raw.terminalDecisionTimeoutMs, 1, 2000, 250),
      retryBudgetMs: intIn(l2Raw && (l2Raw.retryBudgetMs !== undefined ? l2Raw.retryBudgetMs : l2Raw.timeoutMs), 1000, 30000, 15000),
      timeoutMs: intIn(l2Raw && l2Raw.timeoutMs, 1000, 30000, 15000),
      maxAdditionalPromptTokens: intIn(l2Raw && l2Raw.maxAdditionalPromptTokens, 8192, 262144, 131072),
      maxAdditionalCompletionTokens: intIn(l2Raw && l2Raw.maxAdditionalCompletionTokens, 128, 16384, 2048),
      maxAdditionalCostUsd: numberIn(l2Raw && l2Raw.maxAdditionalCostUsd, 0, 10, 0.10),
    },
    l3: {
      enabled: l3Raw ? boolValue(l3Raw.enabled, true) : false,
      maxRedrivesPerEpoch: intIn(l3Raw && l3Raw.maxRedrivesPerEpoch, 0, 3, 1),
      ttlMs: intIn(l3Raw && l3Raw.ttlMs, 60000, 900000, 300000),
    },
  };
  // The compact rollout shape calls this field retryBudgetMs; keep both names
  // coherent so a caller cannot accidentally bypass the hard retry deadline.
  out.l2.timeoutMs = Math.min(out.l2.timeoutMs, out.l2.retryBudgetMs);
  out.l2.retryBudgetMs = out.l2.timeoutMs;
  return out;
}

function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value));
}

function envBool(name) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) return undefined;
  var value = String(process.env[name]).trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return undefined;
}

function readInjectionConfig() {
  var raw;
  var loaded = false;
  try {
    raw = JSON.parse(fs.readFileSync(injectionPath(), "utf8"));
    loaded = true;
  } catch (err) {
    raw = undefined;
  }
  var config = normalizeConfig(raw);
  // Test/rollout overrides are intentionally narrow and never introduce a
  // secret or a prompt.  An invalid override is ignored and the file remains
  // authoritative.  OPENBOT_INJECTION_MODE also lets deterministic tests run
  // without creating a sand-data file.
  var envMode = process.env.OPENBOT_INJECTION_MODE;
  if (envMode === "off" || envMode === "dry-run" || envMode === "enforce") {
    config.mode = envMode;
    loaded = true;
  }
  var overrides = [
    ["OPENBOT_INJECTION_L1_ENABLED", "l1"],
    ["OPENBOT_INJECTION_L2_ENABLED", "l2"],
    ["OPENBOT_INJECTION_L3_ENABLED", "l3"],
  ];
  for (var i = 0; i < overrides.length; i++) {
    var value = envBool(overrides[i][0]);
    if (value !== undefined) {
      config[overrides[i][1]].enabled = value;
      loaded = true;
    }
  }
  if (!loaded && !process.env.OPENBOT_INJECTION_MODE) return cloneConfig(DEFAULT_CONFIG);
  if (config.mode === "off") return { mode: "off" };
  return config;
}

function contextFromRequest(req, body, observed) {
  var trusted;
  if (req && isRecord(req.openbotHostContext)) trusted = Object.assign({}, req.openbotHostContext, { trusted: true, source: "in-process-host" });
  else if (req && isRecord(req.hostContext)) trusted = Object.assign({}, req.hostContext, { trusted: true, source: "in-process-host" });
  var input = isRecord(observed) ? Object.assign({}, observed) : {};
  if (isRecord(body)) {
    if (!stringValue(input.botId)) input.botId = stringValue(body.botId);
    if (!stringValue(input.conversationId)) input.conversationId = stringValue(body.conversationId || body.conversation_id || body.sessionId || body.session_id || body.chatId || body.chat_id);
    if (!stringValue(input.epochId)) input.epochId = stringValue(body.epochId || body.epoch_id);
    if (!stringValue(input.chatType)) input.chatType = stringValue(body.chatType || body.chat_type);
    if (body.directChat === true || body.direct_chat === true) input.directChat = true;
    if (body.internalLane === true || body.internal_lane === true) input.internalLane = true;
  }
  if (trusted) return { hostContext: trusted, observed: input };
  return { observed: input };
}

function isTrustedContext(value) {
  if (!isRecord(value)) return false;
  if (value.trusted === true || value.authenticated === true || value.source === "in-process-host") return true;
  if (isRecord(value.auth) && (value.authenticated === true || value.auth.inProcessHostBinding === true)) return true;
  return false;
}

function hasExplicitHostShape(value) {
  return isRecord(value) && (
    Object.prototype.hasOwnProperty.call(value, "hidden") ||
    Object.prototype.hasOwnProperty.call(value, "requestSource") ||
    Object.prototype.hasOwnProperty.call(value, "isSubagent") ||
    Object.prototype.hasOwnProperty.call(value, "isSilenceAllowed") ||
    Object.prototype.hasOwnProperty.call(value, "isRoutine") ||
    Object.prototype.hasOwnProperty.call(value, "chatType")
  );
}

function personOpenedPermission(input, options) {
  var opts = isRecord(options) ? options : {};
  var source = isRecord(input) ? input : {};
  var host = isRecord(source.hostContext) ? source.hostContext : (isTrustedContext(source) || hasExplicitHostShape(source) ? source : undefined);
  var observed = isRecord(source.observed) ? source.observed : source;
  var trusted = Boolean(host && (isTrustedContext(host) || hasExplicitHostShape(host)));
  var values = trusted ? host : observed;
  var requireEpoch = opts.requireEpoch === true;
  function fail(reason, uncertainty) {
    return {
      eligible: false,
      identityGate: "fail",
      skipReason: reason,
      source: trusted ? "authenticated-host" : "observable-fallback",
      uncertain: Boolean(uncertainty),
    };
  }
  var botId = stringValue(values && values.botId);
  var conversationId = stringValue(values && values.conversationId);
  var epochId = stringValue(values && (values.epochId || values.epoch));
  if (!botId) return fail("no_bot_id", !trusted);
  if (!conversationId) return fail("missing_conversation_id", !trusted);
  if (requireEpoch && !epochId) return fail("missing_epoch", !trusted);
  if (values && (values.groupFlag === true || values.chatType === "group" || values.isGroup === true)) return fail("group_chat", false);
  if (values && values.hidden === true) return fail("hidden_context", false);
  if (values && values.isSubagent === true) return fail("subagent_context", false);
  if (values && values.isSilenceAllowed === true) return fail("silence_allowed", false);
  if (values && (values.isRoutine === true || values.routine === true || values.automation === true || values.isAutomation === true)) return fail("routine_or_automation", false);
  if (trusted) {
    if (values.hidden !== false || values.isSubagent !== false || values.isSilenceAllowed !== false || values.isRoutine !== false) return fail("unknown_identity", false);
    if (values.requestSource !== "person") return fail(values.requestSource ? "non_person" : "unknown_identity", false);
    if (!values.chatType || values.chatType === "group") return fail("unknown_chat_type", false);
    if (values.groupFlag !== false && values.groupFlag !== undefined) return fail("unknown_group_state", false);
    if (values.isGroupMemberTurn !== false && values.isGroupMemberTurn !== undefined) return fail("unknown_group_state", false);
    return { eligible: true, identityGate: "pass", source: "authenticated-host", uncertain: false, botId: botId, conversationId: conversationId, epochId: epochId };
  }
  // Fallback is deliberately narrow: a present bot/conversation identity and
  // an explicit direct-chat signal are observable, but remain uncertain.  No
  // visible prompt or transcript text is inspected to establish identity.
  if (observed && observed.internalLane === true) return fail("internal_lane", true);
  if (observed && observed.chatType === "group") return fail("group_chat", true);
  if (!(observed && (observed.directChat === true || observed.chatType === "dm" || observed.chatType === "direct"))) return fail("unknown_chat_type", true);
  if (observed && (observed.hidden === true || observed.isSubagent === true || observed.isSilenceAllowed === true || observed.isRoutine === true || observed.automation === true)) return fail("unknown_identity", true);
  return { eligible: true, identityGate: "pass", source: "observable-fallback", uncertain: true, botId: botId, conversationId: conversationId, epochId: epochId };
}

function valueText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(valueText).join("\n");
  if (isRecord(value)) {
    if (value.text !== undefined) return valueText(value.text);
    if (value.content !== undefined) return valueText(value.content);
  }
  return "";
}

function isReminderOnly(text) {
  var value = String(text || "");
  if (value.indexOf(HIDDEN_MARKER) === 0) return true;
  if (value === REPLY_FIRST_REMINDER || value === START_ACK_REMINDER || value === WATCHING_SILENCE_REMINDER || value === EARLY_RESULT_REMINDER) return true;
  if (value === REPLY_NUDGE_PROMPT || value === CLOSING_SEND_PROMPT) return true;
  return false;
}

function isRealUserMessage(row) {
  return isRecord(row) && row.role === "user" && !isReminderOnly(valueText(row.content));
}

function sequenceOf(row, fallback) {
  if (isRecord(row)) {
    var n = finiteNumber(row.sequence);
    if (n !== undefined) return n;
    n = finiteNumber(row.eventSequence);
    if (n !== undefined) return n;
  }
  return fallback;
}

function callIdOf(call, fallback) {
  if (!isRecord(call)) return fallback || "";
  return stringValue(call.id || call.tool_call_id || call.toolCallId) || fallback || "";
}

function toolNameOf(call) {
  if (!isRecord(call)) return "";
  if (typeof call.name === "string" && call.name) return call.name;
  if (typeof call.toolName === "string" && call.toolName) return call.toolName;
  if (typeof call.tool_name === "string" && call.tool_name) return call.tool_name;
  if (isRecord(call.function) && typeof call.function.name === "string") return call.function.name;
  return "";
}

function canonicalToolName(name) {
  var value = String(name || "");
  var keys = Object.keys(DELIVERY_NAMES);
  for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === value.toLowerCase()) return keys[i];
  return value;
}

function callArgs(call) {
  if (!isRecord(call)) return "{}";
  var args = call.args !== undefined ? call.args : (isRecord(call.function) ? call.function.arguments : call.arguments);
  if (typeof args === "string") return args || "{}";
  if (args === undefined || args === null) return "{}";
  try { return JSON.stringify(args); } catch (err) { return "{}"; }
}

function callsFromMessage(row) {
  var out = [];
  if (!isRecord(row)) return out;
  if (Array.isArray(row.tool_calls)) out = out.concat(row.tool_calls);
  if (Array.isArray(row.content)) {
    for (var i = 0; i < row.content.length; i++) {
      var part = row.content[i];
      if (isRecord(part) && (part.type === "tool-call" || part.type === "tool_use" || part.type === "function_call")) out.push(part);
    }
  }
  return out;
}

function latestRealUser(messages, context) {
  var rows = Array.isArray(messages) ? messages : [];
  var wanted = stringValue(context && (context.latestRealUserMessageId || context.latestUserMessageId));
  var found = null;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!isRealUserMessage(row)) continue;
    if (wanted && (String(row.id || row.messageId || "") === wanted)) found = { index: i, id: wanted, sequence: sequenceOf(row, i) };
    else if (!wanted) found = { index: i, id: stringValue(row.id || row.messageId) || "unknown", sequence: sequenceOf(row, i) };
  }
  if (found) return found;
  if (wanted) return { index: -1, id: wanted, sequence: finiteNumber(context && context.latestRealUserMessageSequence) === undefined ? "unknown" : Number(context.latestRealUserMessageSequence) };
  return null;
}

function hostEventLists(options) {
  var opts = isRecord(options) ? options : {};
  var events = Array.isArray(opts.hostEvents) ? opts.hostEvents : [];
  var observed = Object.create(null);
  var failed = Object.create(null);
  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    if (!isRecord(event)) continue;
    var id = stringValue(event.toolCallId || event.tool_call_id || event.id);
    if (event.kind === "delivery-observed" && id) observed[id] = event;
    if (event.kind === "delivery-error-observed" && id) failed[id] = event;
  }
  return { events: events, observed: observed, failed: failed };
}

function classifyDebt(options) {
  var opts = isRecord(options) ? options : {};
  var rows = Array.isArray(opts.messages) ? opts.messages : [];
  var context = isRecord(opts.context) ? opts.context : {};
  var boundary = latestRealUser(rows, context);
  if (!boundary && !opts.latestRealUserMessageId) {
    return {
      debtState: "unknown", debtShape: "unknown", latestRealUserMessageId: "unknown", latestRealUserMessageSequence: "unknown",
      lastTouchSequence: "unknown", toolCallsAfterLastTouch: "unknown", touchClassification: "unknown",
      touchesSinceLatestUser: [], textDeliveryCallsEmitted: 0, nonDeliveryToolCalls: 0,
      hostDeliveryEventMode: opts.hostEventContract === true || (Array.isArray(opts.hostEvents) && opts.hostEvents.length > 0) ? "available" : "unavailable",
    };
  }
  var start = boundary && boundary.index >= 0 ? boundary.index + 1 : 0;
  var eventSeq = boundary && boundary.sequence !== "unknown" ? Number(boundary.sequence) : 0;
  var lists = hostEventLists(opts);
  var touches = [];
  var toolEvents = [];
  var textDeliveryCalls = 0;
  var nonDelivery = 0;
  var currentResponseCalls = Array.isArray(opts.currentResponseToolCalls) ? opts.currentResponseToolCalls : [];
  for (var i = start; i < rows.length; i++) {
    var row = rows[i];
    var calls = callsFromMessage(row);
    for (var j = 0; j < calls.length; j++) {
      var call = calls[j];
      var seq = ++eventSeq;
      var rawName = toolNameOf(call);
      var name = canonicalToolName(rawName);
      var id = callIdOf(call, "call_" + String(seq));
      var item = { name: name, id: id, args: callArgs(call), sequence: seq };
      if (DELIVERY_NAMES[name]) {
        var failedEvent = lists.failed[id];
        var observedEvent = lists.observed[id];
        if (failedEvent) item.evidence = "failed";
        else if (observedEvent) item.evidence = "delivery-observed";
        else item.evidence = "call-emitted-fallback";
        touches.push(item);
        if (TEXT_DELIVERY_NAMES[name]) {
          var argsText = item.args;
          var isText = false;
          try { isText = JSON.parse(argsText).type === "text"; } catch (err) { isText = false; }
          if (isText) textDeliveryCalls += 1;
        }
      } else {
        nonDelivery += 1;
      }
      toolEvents.push({ sequence: seq, name: name, id: id, isDelivery: Boolean(DELIVERY_NAMES[name]) });
    }
    // A paired role=tool row is an execution observation, not another call.
    // It establishes chronology only when no assistant call row was available.
    if (row && row.role === "tool" && calls.length === 0) {
      toolEvents.push({ sequence: ++eventSeq, name: "tool-result", id: callIdOf(row, ""), isDelivery: false });
      nonDelivery += 1;
    }
  }
  for (var k = 0; k < currentResponseCalls.length; k++) {
    var current = currentResponseCalls[k];
    var currentSeq = ++eventSeq;
    var currentName = canonicalToolName(toolNameOf(current));
    var currentId = callIdOf(current, "stream-call-" + String(currentSeq));
    if (DELIVERY_NAMES[currentName]) touches.push({ name: currentName, id: currentId, args: callArgs(current), sequence: currentSeq, evidence: "call-emitted-fallback" });
    toolEvents.push({ sequence: currentSeq, name: currentName, id: currentId, isDelivery: Boolean(DELIVERY_NAMES[currentName]) });
  }
  var last = touches.length ? touches[touches.length - 1] : null;
  var after = 0;
  if (last) for (var t = 0; t < toolEvents.length; t++) if (toolEvents[t].sequence > last.sequence) after += 1;
  var failedTouch = false;
  for (var f = 0; f < touches.length; f++) if (touches[f].evidence === "failed") failedTouch = true;
  var shape;
  var state;
  if (!touches.length || failedTouch && touches.every(function (x) { return x.evidence === "failed"; })) {
    shape = "no-touch";
    state = "owed";
  } else if (after > 0) {
    shape = "touch-then-tool";
    state = "owed";
  } else {
    shape = "touch-no-tool";
    state = "not-owed";
  }
  var touchClassification = !touches.length ? "none" : failedTouch ? "failed" : touches.some(function (x) { return x.evidence === "delivery-observed"; }) ? "observed" : "initiated-fallback";
  return {
    debtState: state,
    debtShape: shape,
    latestRealUserMessageId: boundary ? boundary.id : "unknown",
    latestRealUserMessageSequence: boundary ? boundary.sequence : "unknown",
    lastTouchSequence: last ? last.sequence : "none",
    toolCallsAfterLastTouch: after,
    touchClassification: touchClassification,
    hostDeliveryEventMode: opts.hostEventContract === true || lists.events.length > 0 ? "available" : "unavailable",
    touchesSinceLatestUser: touches,
    textDeliveryCallsEmitted: textDeliveryCalls,
    nonDeliveryToolCalls: nonDelivery,
    sentMessageCount: opts.sentMessageCount === undefined ? "unknown" : opts.sentMessageCount,
    reacted: opts.reacted === undefined ? "unknown" : opts.reacted,
    awaitingUserSelection: opts.awaitingUserSelection === undefined ? "unknown" : opts.awaitingUserSelection,
    completionReason: opts.completionReason === undefined ? "unknown" : opts.completionReason,
  };
}

function createHashState() {
  return { hash: crypto.createHash("sha256"), bytes: 0 };
}

function updateHash(state, value) {
  if (!state || !state.hash) return;
  var bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ""), "utf8");
  state.hash.update(bytes);
  state.bytes += bytes.length;
}

function digestHash(state) {
  if (!state || !state.hash) return undefined;
  try { return state.hash.copy().digest("hex"); } catch (err) { return undefined; }
}

function createObservation() {
  return {
    finishReasons: [],
    terminalEvents: [],
    assistantToolCalls: [],
    currentResponseToolCallCount: 0,
    deliveryCallsEmitted: [],
    deliveryObserved: [],
    deliveryErrorsObserved: [],
    toolExecutionsObserved: [],
    firstByteForwardedAt: 0,
    firstContentAt: 0,
    terminalHoldState: "none",
    heldTerminalBytes: 0,
    parserComplete: false,
    _toolKeys: Object.create(null),
    _hash: createHashState(),
    _sequence: 0,
  };
}

function mergeCall(existing, call) {
  if (!existing) return {
    name: toolNameOf(call), id: callIdOf(call, ""), args: callArgs(call), choiceIndex: finiteNumber(call && call.choiceIndex) === undefined ? 0 : Number(call.choiceIndex), sequence: 0,
  };
  var name = toolNameOf(call);
  if (name) existing.name = name;
  var id = callIdOf(call, "");
  if (id) existing.id = id;
  var args = callArgs(call);
  if (args && args !== "{}") existing.args = existing.args === "{}" ? args : existing.args + args;
  return existing;
}

function observeChatEvent(observation, event, bytes) {
  var obs = observation || createObservation();
  if (bytes !== undefined) updateHash(obs._hash, bytes);
  if (!obs.firstByteForwardedAt) obs.firstByteForwardedAt = Date.now();
  if (!isRecord(event)) return obs;
  var choices = Array.isArray(event.choices) ? event.choices : [];
  for (var i = 0; i < choices.length; i++) {
    var choice = choices[i] || {};
    var finish = choice.finish_reason !== undefined ? choice.finish_reason : choice.finishReason;
    if (finish !== null && finish !== undefined && finish !== "") obs.finishReasons.push(String(finish));
    var delta = isRecord(choice.delta) ? choice.delta : (isRecord(choice.message) ? choice.message : {});
    var calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : (Array.isArray(delta.toolCalls) ? delta.toolCalls : []);
    if (calls.length) {
      for (var j = 0; j < calls.length; j++) {
        var call = calls[j] || {};
        var index = finiteNumber(call.index) === undefined ? j : Number(call.index);
        var key = callIdOf(call, "") || String(i) + ":" + String(index);
        var existing = obs._toolKeys[key];
        if (!existing) {
          existing = mergeCall(undefined, call);
          existing.choiceIndex = i;
          existing.sequence = ++obs._sequence;
          obs._toolKeys[key] = existing;
          obs.assistantToolCalls.push(existing);
          obs.currentResponseToolCallCount += 1;
        } else {
          mergeCall(existing, call);
        }
        var normalizedName = canonicalToolName(existing.name);
        if (DELIVERY_NAMES[normalizedName] && !obs.deliveryCallsEmitted.some(function (item) { return item.id === existing.id && item.name === normalizedName; })) {
          obs.deliveryCallsEmitted.push({ name: normalizedName, id: existing.id, args: existing.args, choiceIndex: existing.choiceIndex, sequence: existing.sequence });
        }
      }
    }
    if (typeof delta.content === "string" && delta.content && !obs.firstContentAt) obs.firstContentAt = Date.now();
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content && !obs.firstContentAt) obs.firstContentAt = Date.now();
  }
  if (Array.isArray(event.deliveryObserved)) obs.deliveryObserved = obs.deliveryObserved.concat(event.deliveryObserved);
  if (Array.isArray(event.deliveryErrorsObserved)) obs.deliveryErrorsObserved = obs.deliveryErrorsObserved.concat(event.deliveryErrorsObserved);
  if (Array.isArray(event.toolExecutionsObserved)) obs.toolExecutionsObserved = obs.toolExecutionsObserved.concat(event.toolExecutionsObserved);
  return obs;
}

function finalizeObservation(observation, parserComplete) {
  var obs = observation || createObservation();
  obs.parserComplete = parserComplete !== false;
  obs.currentResponseToolCallCount = Number(obs.currentResponseToolCallCount || 0);
  obs.firstResponseHash = digestHash(obs._hash);
  return obs;
}

function observationFromChatResponse(response) {
  var obs = createObservation();
  observeChatEvent(obs, response, Buffer.from(JSON.stringify(response || {}), "utf8"));
  return finalizeObservation(obs, true);
}

function silentStop(observation) {
  var obs = observation || {};
  if (!obs.parserComplete || !Array.isArray(obs.finishReasons) || !obs.finishReasons.length) return false;
  for (var i = 0; i < obs.finishReasons.length; i++) if (obs.finishReasons[i] !== "stop") return false;
  return Number(obs.currentResponseToolCallCount || 0) === 0;
}

function stateKeyFrom(permission) {
  if (!permission || !permission.eligible) return "";
  if (!permission.botId || !permission.conversationId || !permission.epochId) return "";
  return permission.conversationId + "\0" + permission.botId + "\0" + permission.epochId;
}

function stateFor(key, create) {
  if (!key) return undefined;
  var value = epochStates.get(key);
  if (!value && create) {
    value = {
      l2AdditionalRuns: 0,
      l3Redrives: 0,
      finalNoTool: false,
      lastResponseSilent: false,
      latestRealUserMessageId: "unknown",
      latestRealUserMessageSequence: "unknown",
      lastShape: "unknown",
      updatedAt: Date.now(),
    };
    epochStates.set(key, value);
  }
  return value;
}

function acquireLease(key) {
  if (!key) return null;
  if (terminalLeases.get(key)) return null;
  var token = { key: key, released: false };
  terminalLeases.set(key, token);
  return token;
}

function releaseLease(token) {
  if (!token || token.released) return;
  token.released = true;
  if (terminalLeases.get(token.key) === token) terminalLeases.delete(token.key);
}

function writerCall(writer, bytes) {
  try {
    if (typeof writer === "function") writer(bytes);
    else if (writer && typeof writer.write === "function") writer.write(bytes);
  } catch (err) {
    return false;
  }
  return true;
}

function createTerminalHold(writer, observation) {
  var held = [];
  var released = false;
  var superseded = false;
  var releasedReason;
  function hold(value) {
    if (released || superseded) return;
    var bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value || ""), "utf8");
    held.push(bytes);
    if (observation) {
      observation.terminalHoldState = "held";
      observation.heldTerminalBytes = held.reduce(function (n, item) { return n + item.length; }, 0);
    }
  }
  function release(reason) {
    if (released || superseded) return { released: false, bytes: 0, reason: releasedReason };
    released = true;
    releasedReason = reason || "release";
    var copy = held.slice();
    var bytes = 0;
    for (var i = 0; i < copy.length; i++) {
      bytes += copy[i].length;
      writerCall(writer, copy[i]);
    }
    held.length = 0;
    if (observation) {
      observation.terminalHoldState = "replayed";
      observation.heldTerminalBytes = 0;
    }
    return { released: true, bytes: bytes, reason: releasedReason };
  }
  function discard() {
    held.length = 0;
    if (observation) observation.heldTerminalBytes = 0;
  }
  function supersede() {
    if (released || superseded) return false;
    superseded = true;
    held.length = 0;
    if (observation) {
      observation.terminalHoldState = "superseded";
      observation.heldTerminalBytes = 0;
    }
    return true;
  }
  function releaseSecond(reason) {
    if (released || superseded) return { released: false, bytes: 0, reason: releasedReason };
    released = true;
    releasedReason = reason || "second-success";
    var copy = held.slice();
    var bytes = 0;
    for (var i = 0; i < copy.length; i++) {
      bytes += copy[i].length;
      writerCall(writer, copy[i]);
    }
    held.length = 0;
    if (observation) {
      observation.terminalHoldState = "released";
      observation.heldTerminalBytes = 0;
    }
    return { released: true, bytes: bytes, reason: releasedReason };
  }
  return {
    hold: hold,
    release: release,
    releaseSecond: releaseSecond,
    discard: discard,
    supersede: supersede,
    isHeld: function () { return held.length > 0 && !released && !superseded; },
    bytes: function () { return held.reduce(function (n, item) { return n + item.length; }, 0); },
    values: function () { return held.slice(); },
    get released() { return released; },
    get superseded() { return superseded; },
    get releasedReason() { return releasedReason; },
  };
}

function buildNudgeMessages(messages, shape) {
  var base = Array.isArray(messages) ? messages.slice() : [];
  var body = shape === "touch-then-tool" ? CLOSING_SEND_PROMPT : REPLY_NUDGE_PROMPT;
  base.push({ role: "user", content: HIDDEN_MARKER + body });
  return base;
}

function fingerprint(permission, family) {
  var value = [permission && permission.conversationId, permission && permission.botId, permission && permission.epochId, family, TEMPLATE_VERSION].map(function (x) { return String(x || ""); }).join("\0");
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function estimatePromptTokens(messages, shape, supplied) {
  var explicit = finiteNumber(supplied);
  if (explicit !== undefined && explicit >= 0) return Math.ceil(explicit);
  var body = shape === "touch-then-tool" ? CLOSING_SEND_PROMPT : REPLY_NUDGE_PROMPT;
  try { return Math.ceil(Buffer.byteLength(JSON.stringify(buildNudgeMessages(messages, shape)), "utf8") / 4) + Math.ceil(Buffer.byteLength(body, "utf8") / 4); } catch (err) { return Number.POSITIVE_INFINITY; }
}

function budgetReason(options, config, messages, shape) {
  var opts = isRecord(options) ? options : {};
  var l2 = config.l2;
  var promptTokens = estimatePromptTokens(messages, shape, opts.promptTokensEstimated);
  if (!Number.isFinite(promptTokens) || promptTokens > l2.maxAdditionalPromptTokens) return { reason: "budget_prompt", promptTokens: promptTokens };
  var completion = finiteNumber(opts.completionTokensCap);
  if (completion === undefined) completion = l2.maxAdditionalCompletionTokens;
  if (completion > l2.maxAdditionalCompletionTokens) return { reason: "budget_completion", promptTokens: promptTokens, completionTokens: completion };
  var actualCost = finiteNumber(opts.estimatedCostUsd);
  var rate = opts.modelRates;
  if (actualCost === undefined && isRecord(rate)) {
    var input = finiteNumber(rate.input !== undefined ? rate.input : rate.prompt);
    var output = finiteNumber(rate.output !== undefined ? rate.output : rate.completion);
    if (input !== undefined && output !== undefined) actualCost = promptTokens * input + completion * output;
  }
  if (actualCost === undefined && opts.requireKnownCost === true) return { reason: "budget_cost", promptTokens: promptTokens, completionTokens: completion };
  if (actualCost !== undefined && actualCost > l2.maxAdditionalCostUsd) return { reason: "budget_cost", promptTokens: promptTokens, completionTokens: completion, cost: actualCost };
  return { promptTokens: promptTokens, completionTokens: completion, cost: actualCost };
}

function makeLogMeta(config, permission) {
  if (!config || config.mode === "off") return undefined;
  return {
    mode: config.mode,
    family: undefined,
    identityGate: permission ? permission.identityGate : undefined,
    skipReason: permission && !permission.eligible ? permission.skipReason : undefined,
    l2Eligible: false,
    l2Attempted: false,
    l2Outcome: permission && !permission.eligible ? "not-eligible" : undefined,
    l2AdditionalRuns: 0,
    l2AddedLatencyMs: 0,
    heldTerminalBytes: 0,
    heldReleasedReason: undefined,
    finalNoTool: false,
  };
}

function applyPreGeneration(messages, options) {
  var opts = isRecord(options) ? options : {};
  var config = opts.config || readInjectionConfig();
  if (!config || config.mode === "off") return { messages: messages, injection: undefined, config: { mode: "off" } };
  var context = opts.context || {};
  var permission = personOpenedPermission(context, { requireEpoch: false });
  var meta = makeLogMeta(config, permission);
  var working = Array.isArray(messages) ? messages.slice() : messages;
  var keyPermission = personOpenedPermission(context, { requireEpoch: true });
  var key = stateKeyFrom(keyPermission);
  var state = stateFor(key, Boolean(key));
  var ledger = classifyDebt({ messages: working, context: context, hostEvents: opts.hostEvents, hostEventContract: opts.hostEventContract });
  meta.identityGate = permission.identityGate;
  meta.l2Eligible = Boolean(keyPermission.eligible && config.l2.enabled && config.mode === "enforce");
  meta.injectionFingerprint = key ? fingerprint(keyPermission, "pre") : undefined;
  meta.latestRealUserMessageId = ledger.latestRealUserMessageId;
  meta.debtState = ledger.debtState;
  meta.debtShape = ledger.debtShape;
  var selected;
  var opening = opts.opening === true || context.opening === true;
  if (config.l1.enabled && permission.eligible) {
    if (opening && Array.isArray(working)) {
      var openingIndex = -1;
      for (var oi = 0; oi < working.length; oi++) if (isRealUserMessage(working[oi])) { openingIndex = oi; break; }
      if (openingIndex >= 0) {
        var openingText = valueText(working[openingIndex].content);
        if (openingText.indexOf(REPLY_FIRST_BODY) < 0 && openingText.indexOf(REPLY_FIRST_REMINDER) < 0) {
          selected = { family: "l1.reply-first", body: REPLY_FIRST_REMINDER, index: openingIndex, opening: true };
        }
      }
    }
    if (!selected && Array.isArray(working)) {
      var lastReminder = state && state.lastReminderFamily;
      var exactLast = working.length ? valueText(working[working.length - 1].content) : "";
      var exactAlready = exactLast === START_ACK_REMINDER || exactLast === WATCHING_SILENCE_REMINDER || exactLast === EARLY_RESULT_REMINDER;
      var nonDelivery = ledger.nonDeliveryToolCalls;
      var toolSince = ledger.lastTouchSequence === "none" ? nonDelivery : ledger.toolCallsAfterLastTouch;
      if (!exactAlready && (!lastReminder || (state && state.silentStreakId !== ledger.latestRealUserMessageId))) {
        if (toolSince > config.l1.watchingSilenceThreshold) selected = { family: "l1.silence", body: WATCHING_SILENCE_REMINDER };
        else if (toolSince > config.l1.earlyResultThreshold && ledger.textDeliveryCallsEmitted > 0) selected = { family: "l1.early-result", body: EARLY_RESULT_REMINDER };
        else if (ledger.textDeliveryCallsEmitted === 0 && nonDelivery > config.l1.startOfTurnAckThreshold) selected = { family: "l1.start-ack", body: START_ACK_REMINDER };
      }
    }
  }
  if (selected) {
    meta.family = selected.family;
    meta.injectionWouldApply = true;
    meta.bodyHash = crypto.createHash("sha256").update(selected.body, "utf8").digest("hex");
    if (config.mode === "enforce" && Array.isArray(working)) {
      if (selected.opening) {
        var row = working[selected.index];
        if (typeof row.content === "string") row.content = row.content + selected.body;
        else row.content = valueText(row.content) + selected.body;
      } else {
        working.push({ role: "user", content: selected.body });
      }
      if (state) {
        state.lastReminderFamily = selected.family;
        state.silentStreakId = ledger.latestRealUserMessageId;
        state.updatedAt = Date.now();
      }
      meta.injectionApplied = true;
    }
  } else {
    meta.injectionWouldApply = false;
  }
  // L3 is intentionally next-request only and is suppressed by finalNoTool.
  if (!selected && config.l3.enabled && config.mode === "enforce" && keyPermission.eligible && state && state.lastResponseSilent && !state.finalNoTool && Date.now() - state.updatedAt <= config.l3.ttlMs) {
    var historical = classifyDebt({ messages: working, context: context, hostEvents: opts.hostEvents, hostEventContract: opts.hostEventContract });
    if (historical.debtState === "owed" && (historical.debtShape === "no-touch" || historical.debtShape === "touch-then-tool") && state.l3Redrives < config.l3.maxRedrivesPerEpoch) {
      var l3Shape = historical.debtShape;
      var l3Family = l3Shape === "touch-then-tool" ? "l3.closing-send" : "l3.reply-nudge";
      var l3Body = l3Shape === "touch-then-tool" ? CLOSING_SEND_PROMPT : REPLY_NUDGE_PROMPT;
      var l3Text = HIDDEN_MARKER + l3Body;
      var lastText = working.length ? valueText(working[working.length - 1].content) : "";
      if (lastText !== l3Text) {
        working.push({ role: "user", content: l3Text });
        state.l3Redrives += 1;
        state.updatedAt = Date.now();
        meta.family = l3Family;
        meta.injectionWouldApply = true;
        meta.injectionApplied = true;
        meta.l3Redrive = true;
        meta.l3Shape = l3Shape;
      }
    }
  }
  return { messages: working, injection: meta, config: config, permission: keyPermission, stateKey: key, state: state };
}

function withTimeout(promise, timeoutMs, onTimeout) {
  var ms = Math.max(1, Number(timeoutMs) || 1);
  var timer;
  var timeout = new Promise(function (resolve) {
    timer = setTimeout(function () {
      try { if (onTimeout) onTimeout(); } catch (err) { /* watchdog is best effort */ }
      resolve({ __timeout: true });
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(function () { clearTimeout(timer); });
}

function safeRelease(hold, reason) {
  if (!hold || typeof hold.release !== "function") return { released: false, bytes: 0, reason: reason };
  try { return hold.release(reason); } catch (err) {
    try { if (typeof hold.discard === "function") hold.discard(); } catch (ignored) {}
    return { released: true, bytes: 0, reason: reason };
  }
}

async function runL2(options) {
  var opts = isRecord(options) ? options : {};
  var config = opts.config || readInjectionConfig();
  var startAt = Date.now();
  var meta = opts.injection || makeLogMeta(config, undefined);
  var firstHold = opts.heldTerminal;
  var observation = opts.observation || createObservation();
  var context = opts.context || {};
  var permission = personOpenedPermission(context, { requireEpoch: true });
  var result = {
    injection: meta,
    observation: observation,
    permission: permission,
    l2Outcome: "not-eligible",
    l2Attempted: false,
    l2AdditionalRuns: 0,
    finalNoTool: false,
    heldReleasedReason: undefined,
    second: undefined,
  };
  function release(reason, outcome) {
    result.heldReleasedReason = reason;
    result.l2Outcome = outcome || result.l2Outcome;
    safeRelease(firstHold, reason);
    meta.heldTerminalBytes = 0;
    meta.heldReleasedReason = reason;
    meta.l2Outcome = result.l2Outcome;
    meta.l2AddedLatencyMs = Date.now() - startAt;
    return result;
  }
  if (!firstHold) return result;
  if (!config || config.mode !== "enforce" || !config.l2.enabled) return release("mode_or_layer_disabled", "not-eligible");
  if (!permission.eligible) {
    meta.skipReason = permission.skipReason;
    return release(permission.skipReason || "not_eligible", "not-eligible");
  }
  if (!silentStop(observation)) {
    meta.skipReason = observation.currentResponseToolCallCount > 0 ? "response_has_tool_calls" : "terminal_not_silent";
    return release(meta.skipReason, "classification-skipped");
  }
  var debt = classifyDebt({
    messages: opts.messages,
    context: context,
    currentResponseToolCalls: [],
    hostEvents: opts.hostEvents,
    hostEventContract: opts.hostEventContract,
  });
  meta.latestRealUserMessageId = debt.latestRealUserMessageId;
  meta.debtState = debt.debtState;
  meta.debtShape = debt.debtShape;
  meta.touchClassification = debt.touchClassification;
  meta.toolCallsAfterLastTouch = debt.toolCallsAfterLastTouch;
  if (debt.debtState !== "owed" || (debt.debtShape !== "no-touch" && debt.debtShape !== "touch-then-tool")) {
    meta.skipReason = "debt_not_owed";
    meta.family = "l2.no-op";
    return release("debt_not_owed", "not-eligible");
  }
  var key = opts.stateKey || stateKeyFrom(permission);
  var state = stateFor(key, true);
  if (state && state.finalNoTool) {
    meta.skipReason = "l2_attempt_exhausted";
    meta.finalNoTool = true;
    result.finalNoTool = true;
    return release("l2_attempt_exhausted", "classification-skipped");
  }
  if (state && state.l2AdditionalRuns >= config.l2.maxAdditionalRuns) {
    meta.skipReason = "l2_attempt_exhausted";
    meta.finalNoTool = true;
    result.finalNoTool = true;
    state.finalNoTool = true;
    return release("l2_attempt_exhausted", "classification-skipped");
  }
  var budget = budgetReason(opts, config, opts.messages, debt.debtShape);
  meta.l2Eligible = true;
  meta.family = debt.debtShape === "touch-then-tool" ? "l2.closing-send" : "l2.reply-nudge";
  meta.l2NudgeShape = debt.debtShape;
  meta.l2PromptTokensEstimated = budget.promptTokens;
  meta.l2CompletionTokenCap = budget.completionTokens;
  if (budget.reason) {
    meta.skipReason = budget.reason;
    return release(budget.reason, "not-eligible");
  }
  var lease = acquireLease(key);
  if (!lease) {
    meta.skipReason = "lease_busy";
    return release("lease_busy", "not-eligible");
  }
  var aborted = false;
  var abortSignal = opts.signal;
  function onAbort() { aborted = true; try { if (opts.abortSecond) opts.abortSecond(); } catch (err) {} }
  if (abortSignal && typeof abortSignal.addEventListener === "function") abortSignal.addEventListener("abort", onAbort, { once: true });
  var watchdog = false;
  try {
    // Parsing, classification, and lease acquisition have a local watchdog
    // independent of the second upstream deadline.  The actual work above is
    // synchronous, but the race protects injected host adapters that yield.
    var decisionResult = await withTimeout(Promise.resolve().then(function () {
      if (aborted) throw new Error("client_closed");
      return true;
    }), config.l2.terminalDecisionTimeoutMs, function () { watchdog = true; safeRelease(firstHold, "terminal_decision_timeout"); });
    if (watchdog || decisionResult && decisionResult.__timeout) {
      meta.skipReason = "terminal_decision_timeout";
      return release("terminal_decision_timeout", "classification-skipped");
    }
    if (aborted) return release("client_closed", "failed-first-fallback");
    state.l2AdditionalRuns += 1;
    meta.l2Attempted = true;
    meta.l2AdditionalRuns = state.l2AdditionalRuns;
    result.l2Attempted = true;
    result.l2AdditionalRuns = state.l2AdditionalRuns;
    var shape = debt.debtShape;
    var secondMessages = buildNudgeMessages(opts.messages, shape);
    var secondPromise;
    try {
      if (typeof opts.runSecond !== "function") throw new Error("missing second-run callback");
      secondPromise = opts.runSecond({
        messages: secondMessages,
        shape: shape,
        body: HIDDEN_MARKER + (shape === "touch-then-tool" ? CLOSING_SEND_PROMPT : REPLY_NUDGE_PROMPT),
        abort: onAbort,
        signal: abortSignal,
        maxCompletionTokens: config.l2.maxAdditionalCompletionTokens,
      });
      var second = await withTimeout(secondPromise, Math.min(config.l2.timeoutMs, config.l2.retryBudgetMs), function () { aborted = true; try { if (opts.abortSecond) opts.abortSecond(); } catch (err) {} });
      if (second && second.__timeout) throw new Error("l2 retry timeout");
      if (aborted) throw new Error("client_closed");
      if (!second || second.ok === false || !second.observation || !silentStop(second.observation) && !second.hasValidTerminal) throw new Error("l2 invalid response");
      var secondHold = second.heldTerminal;
      if (!secondHold) throw new Error("l2 missing terminal");
      var secondSilent = silentStop(second.observation);
      if (secondSilent) {
        state.finalNoTool = true;
        state.lastResponseSilent = true;
        result.finalNoTool = true;
        meta.finalNoTool = true;
        meta.l2Outcome = "valid-no-tool";
      } else {
        meta.l2Outcome = second.observation.deliveryCallsEmitted && second.observation.deliveryCallsEmitted.length ? "call-emitted" : "call-emitted";
      }
      secondHold.releaseSecond("l2-second-terminal");
      firstHold.supersede();
      result.second = second;
      result.l2Outcome = meta.l2Outcome;
      result.heldReleasedReason = "l2-second-terminal";
      meta.heldTerminalBytes = 0;
      meta.heldReleasedReason = "l2-second-terminal";
      meta.l2AddedLatencyMs = Date.now() - startAt;
      state.lastResponseSilent = secondSilent;
      state.latestRealUserMessageId = debt.latestRealUserMessageId;
      state.latestRealUserMessageSequence = debt.latestRealUserMessageSequence;
      state.lastShape = shape;
      state.updatedAt = Date.now();
      return result;
    } catch (err) {
      meta.l2Outcome = "failed-first-fallback";
      return release(err && err.message === "client_closed" ? "client_closed" : "l2_fallback_original_terminal", "failed-first-fallback");
    }
  } catch (err) {
    meta.l2Outcome = "failed-first-fallback";
    return release(err && err.message ? err.message : "l2_exception", "failed-first-fallback");
  } finally {
    if (abortSignal && typeof abortSignal.removeEventListener === "function") abortSignal.removeEventListener("abort", onAbort);
    releaseLease(lease);
    // The hard invariant is logical, not dependent on whether a closed socket
    // accepted the replay bytes.
    meta.heldTerminalBytes = firstHold && typeof firstHold.bytes === "function" ? firstHold.bytes() : 0;
    if (meta.heldTerminalBytes !== 0 && !(firstHold && firstHold.superseded)) safeRelease(firstHold, "l2_finally_release");
    meta.heldTerminalBytes = 0;
  }
}

function rememberResponse(options) {
  var opts = isRecord(options) ? options : {};
  var permission = personOpenedPermission(opts.context || {}, { requireEpoch: true });
  var key = opts.stateKey || stateKeyFrom(permission);
  if (!key) return undefined;
  var state = stateFor(key, true);
  var obs = opts.observation || {};
  state.lastResponseSilent = opts.silent === undefined ? silentStop(obs) : opts.silent === true;
  state.finalNoTool = opts.finalNoTool === true || state.finalNoTool === true;
  state.latestRealUserMessageId = opts.latestRealUserMessageId || state.latestRealUserMessageId;
  state.latestRealUserMessageSequence = opts.latestRealUserMessageSequence || state.latestRealUserMessageSequence;
  state.updatedAt = Date.now();
  return state;
}

function resetForTests() {
  epochStates.clear();
  terminalLeases.clear();
}

module.exports = {
  HIDDEN_MARKER: HIDDEN_MARKER,
  TEMPLATE_VERSION: TEMPLATE_VERSION,
  DELIVERY_NAMES: DELIVERY_NAMES,
  REPLY_NUDGE_PROMPT: REPLY_NUDGE_PROMPT,
  CLOSING_SEND_PROMPT: CLOSING_SEND_PROMPT,
  REPLY_FIRST_BODY: REPLY_FIRST_BODY,
  REPLY_FIRST_REMINDER: REPLY_FIRST_REMINDER,
  START_ACK_REMINDER: START_ACK_REMINDER,
  WATCHING_SILENCE_REMINDER: WATCHING_SILENCE_REMINDER,
  EARLY_RESULT_REMINDER: EARLY_RESULT_REMINDER,
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  injectionPath: injectionPath,
  normalizeConfig: normalizeConfig,
  readInjectionConfig: readInjectionConfig,
  contextFromRequest: contextFromRequest,
  personOpenedPermission: personOpenedPermission,
  classifyDebt: classifyDebt,
  createObservation: createObservation,
  observeChatEvent: observeChatEvent,
  finalizeObservation: finalizeObservation,
  observationFromChatResponse: observationFromChatResponse,
  silentStop: silentStop,
  createTerminalHold: createTerminalHold,
  buildNudgeMessages: buildNudgeMessages,
  fingerprint: fingerprint,
  applyPreGeneration: applyPreGeneration,
  runL2: runL2,
  rememberResponse: rememberResponse,
  stateKeyFrom: stateKeyFrom,
  acquireLease: acquireLease,
  releaseLease: releaseLease,
  resetForTests: resetForTests,
};
