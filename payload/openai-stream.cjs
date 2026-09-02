"use strict";

var { stripHostInjectedText } = require("./openai-messages.cjs");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageContentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  var bits = [];
  for (var i = 0; i < content.length; i++) {
    var part = content[i];
    if (typeof part === "string") {
      bits.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    if (typeof part.text === "string") bits.push(part.text);
  }
  return bits.join("");
}

function reasoningText(value) {
  if (!isRecord(value)) return "";
  if (typeof value.reasoning_content === "string") return value.reasoning_content;
  if (typeof value.reasoning === "string") return value.reasoning;
  return "";
}

function mapToolCalls(openAiCalls) {
  if (!Array.isArray(openAiCalls)) return [];
  var out = [];
  for (var i = 0; i < openAiCalls.length; i++) {
    var raw = openAiCalls[i] || {};
    var fn = raw.function || {};
    var args = {};
    if (typeof fn.arguments === "string") {
      try { args = JSON.parse(fn.arguments || "{}"); } catch (err) { args = {}; }
    } else if (isRecord(fn.arguments)) {
      args = fn.arguments;
    } else if (isRecord(raw.args)) {
      args = raw.args;
    }
    out.push({
      type: "tool-call",
      toolCallId: raw.id || ("call_" + i),
      toolName: fn.name || "",
      args: args,
    });
  }
  return out;
}

function mapFinishReason(reason, toolCallCount) {
  var n = typeof toolCallCount === "number" && toolCallCount > 0 ? toolCallCount : 0;
  if (reason === "length") return "length";
  if (n > 0) return "tool-calls";
  if (reason === "tool_calls" || reason === "tool-calls" || reason === "function_call") {
    return "tool-calls";
  }
  return "stop";
}

function usageFrom(raw) {
  var u = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  if (!isRecord(raw)) return u;
  u.promptTokens = raw.prompt_tokens || raw.promptTokens || 0;
  u.completionTokens = raw.completion_tokens || raw.completionTokens || 0;
  u.totalTokens = raw.total_tokens || raw.totalTokens || 0;
  return u;
}

function toolCallList(buckets) {
  var keys = Object.keys(buckets).sort(function (a, b) {
    return Number(a) - Number(b);
  });
  var out = [];
  for (var i = 0; i < keys.length; i++) {
    out.push(buckets[keys[i]]);
  }
  return out;
}

function mergeToolCalls(buckets, calls) {
  if (!Array.isArray(calls)) return;
  for (var i = 0; i < calls.length; i++) {
    var tc = calls[i];
    if (!isRecord(tc)) continue;
    var idx = Number.isInteger(tc.index) ? tc.index : i;
    if (!buckets[idx]) {
      buckets[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
    }
    var row = buckets[idx];
    if (typeof tc.id === "string" && tc.id) row.id = tc.id;
    var fn = isRecord(tc.function) ? tc.function : {};
    if (typeof fn.name === "string" && fn.name) row.function.name = fn.name;
    if (typeof fn.arguments === "string") {
      row.function.arguments += fn.arguments;
    } else if (isRecord(fn.arguments)) {
      try { row.function.arguments += JSON.stringify(fn.arguments); } catch (err) { /* ignore */ }
    }
  }
}

function mergeFunctionCall(buckets, fn) {
  if (!isRecord(fn)) return;
  mergeToolCalls(buckets, [{ index: 0, id: "call_0", function: fn }]);
}

function asToolCallArray(message) {
  if (!isRecord(message)) return [];
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return message.tool_calls;
  }
  if (isRecord(message.function_call)) {
    return [{ id: "call_0", type: "function", function: message.function_call }];
  }
  return [];
}

function schemaProperties(parameters) {
  var p = parameters;
  if (isRecord(p) && isRecord(p.jsonSchema)) p = p.jsonSchema;
  if (!isRecord(p) || !isRecord(p.properties)) return {};
  return p.properties;
}

function findVoiceTool(tools) {
  if (!Array.isArray(tools)) return null;
  for (var i = 0; i < tools.length; i++) {
    var t = tools[i];
    if (!t) continue;
    var fn = t.function || t;
    var name = t.name || fn.name;
    if (name !== "SendToUser" && name !== "SendMessage") continue;
    return { name: name, parameters: fn.parameters || t.parameters };
  }
  return null;
}

function voiceArgsFromText(text, parameters) {
  var props = schemaProperties(parameters);
  if (props.message && !props.content) {
    return { message: text };
  }
  var args = { content: text };
  if (props.type) args.type = "text";
  return args;
}

function isScratchReasoningText(text) {
  var s = String(text || "").trim();
  if (!s || s.charAt(0) !== "{") return false;
  try {
    var j = JSON.parse(s);
    return isRecord(j) && (j.type === "reasoning" || typeof j.reasoning === "string");
  } catch (err) {
    return false;
  }
}

function alreadyHasVoice(mapped, voiceName) {
  for (var i = 0; i < mapped.length; i++) {
    if (mapped[i] && mapped[i].toolName === voiceName) return true;
  }
  return false;
}

/** Host voice is a tool. Reuse leftover model text only when there are no other calls. */
function mapAssistantTextToVoice(text, mapped, voiceTool) {
  if (!voiceTool || !voiceTool.name) return mapped;
  if (Array.isArray(mapped) && mapped.length) return mapped;
  var body = stripHostInjectedText(String(text || "")).trim();
  if (!body) return mapped;
  if (isScratchReasoningText(body)) return mapped;
  if (alreadyHasVoice(mapped, voiceTool.name)) return mapped;
  var voice = {
    type: "tool-call",
    toolCallId: "call_" + String(mapped.length),
    toolName: voiceTool.name,
    args: voiceArgsFromText(body, voiceTool.parameters),
  };
  return [voice].concat(mapped);
}

function jsonToHostParts(json, voiceTool) {
  var choice = json && json.choices && json.choices[0];
  var message = (choice && choice.message) || {};
  var text = messageContentText(message.content);
  var calls = asToolCallArray(message);
  var reasoning = reasoningText(message);
  var usage = usageFrom(json && json.usage);
  var parts = [];
  if (reasoning) parts.push({ type: "reasoning", textDelta: reasoning });
  if (text) parts.push({ type: "text-delta", textDelta: text });
  var mapped = mapAssistantTextToVoice(text, mapToolCalls(calls), voiceTool);
  for (var i = 0; i < mapped.length; i++) parts.push(mapped[i]);
  parts.push({
    type: "finish",
    finishReason: mapFinishReason(choice && choice.finish_reason, mapped.length),
    usage: usage,
    id: (json && json.id) || "",
  });
  return parts;
}

function sseDataOf(block) {
  var lines = String(block || "").split(/\r?\n/);
  var data = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || line.charAt(0) === ":") continue;
    if (line.slice(0, 5).toLowerCase() === "data:") {
      var rest = line.slice(5);
      if (rest.charAt(0) === " ") rest = rest.slice(1);
      data.push(rest);
    }
  }
  return data.join("\n");
}

function takeSseEvents(buf) {
  var parts = String(buf).split(/\r?\n\r?\n/);
  var rest = parts.pop();
  var events = [];
  for (var i = 0; i < parts.length; i++) {
    var data = sseDataOf(parts[i]);
    if (data) events.push(data);
  }
  return { events: events, rest: rest };
}

function newSseState() {
  return {
    sawDelta: false,
    calls: Object.create(null),
    finishReason: undefined,
    usage: undefined,
    id: "",
    text: "",
  };
}

function applyOpenAiEvent(state, data) {
  var out = [];
  if (!data || data === "[DONE]") return out;
  var json;
  try {
    json = JSON.parse(data);
  } catch (err) {
    return out;
  }
  if (!isRecord(json)) return out;
  if (json.usage) state.usage = json.usage;
  if (typeof json.id === "string") state.id = json.id;
  var choice = json.choices && json.choices[0];
  if (!choice) return out;
  if (choice.finish_reason) state.finishReason = choice.finish_reason;

  var delta = choice.delta;
  if (isRecord(delta)) {
    state.sawDelta = true;
    var r = reasoningText(delta);
    if (r) out.push({ type: "reasoning", textDelta: r });
    var t = messageContentText(delta.content);
    if (t) {
      state.text += t;
      out.push({ type: "text-delta", textDelta: t });
    }
    mergeToolCalls(state.calls, delta.tool_calls);
    if (delta.function_call) mergeFunctionCall(state.calls, delta.function_call);
  }

  var message = choice.message;
  if (isRecord(message)) {
    if (!state.sawDelta) {
      var r2 = reasoningText(message);
      if (r2) out.push({ type: "reasoning", textDelta: r2 });
      var t2 = messageContentText(message.content);
      if (t2) {
        state.text += t2;
        out.push({ type: "text-delta", textDelta: t2 });
      }
    }
    mergeToolCalls(state.calls, message.tool_calls);
    if (message.function_call) mergeFunctionCall(state.calls, message.function_call);
  }
  return out;
}

function finishSse(state, voiceTool) {
  var mapped = mapAssistantTextToVoice(state && state.text, mapToolCalls(toolCallList(state.calls)), voiceTool);
  var out = [];
  for (var i = 0; i < mapped.length; i++) out.push(mapped[i]);
  out.push({
    type: "finish",
    finishReason: mapFinishReason(state.finishReason, mapped.length),
    usage: usageFrom(state.usage),
    id: state.id || "",
  });
  return out;
}

async function* iterateOpenAiResponse(res, voiceTool) {
  var buf = "";
  var mode = null;
  var sse = newSseState();
  for await (var chunk of res) {
    buf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (!mode) {
      var t = buf.replace(/^\uFEFF/, "").trimStart();
      if (!t) continue;
      mode = t.charAt(0) === "{" ? "json" : "sse";
    }
    if (mode !== "sse") continue;
    var parsed = takeSseEvents(buf);
    buf = parsed.rest;
    for (var i = 0; i < parsed.events.length; i++) {
      var evs = applyOpenAiEvent(sse, parsed.events[i]);
      for (var j = 0; j < evs.length; j++) yield evs[j];
    }
  }
  if (mode === "json") {
    var json = JSON.parse(buf);
    var parts = jsonToHostParts(json, voiceTool);
    for (var k = 0; k < parts.length; k++) yield parts[k];
    return;
  }
  if (mode === "sse") {
    if (buf.trim()) {
      var last = takeSseEvents(buf + "\n\n");
      for (var n = 0; n < last.events.length; n++) {
        var more = applyOpenAiEvent(sse, last.events[n]);
        for (var m = 0; m < more.length; m++) yield more[m];
      }
    }
    var tail = finishSse(sse, voiceTool);
    for (var p = 0; p < tail.length; p++) yield tail[p];
  }
}

module.exports = {
  messageContentText: messageContentText,
  mapToolCalls: mapToolCalls,
  mapFinishReason: mapFinishReason,
  jsonToHostParts: jsonToHostParts,
  takeSseEvents: takeSseEvents,
  applyOpenAiEvent: applyOpenAiEvent,
  newSseState: newSseState,
  finishSse: finishSse,
  iterateOpenAiResponse: iterateOpenAiResponse,
  findVoiceTool: findVoiceTool,
  mapAssistantTextToVoice: mapAssistantTextToVoice,
};
