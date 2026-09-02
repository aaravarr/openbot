"use strict";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolCallIdOf(value) {
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.tool_call_id === "string" && value.tool_call_id.trim()) {
    return value.tool_call_id;
  }
  if (typeof value.toolCallId === "string" && value.toolCallId.trim()) {
    return value.toolCallId;
  }
  return "";
}

function toolNameOf(value) {
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.toolName === "string" && value.toolName) {
    return value.toolName;
  }
  if (typeof value.tool_name === "string" && value.tool_name) {
    return value.tool_name;
  }
  if (isRecord(value.function) && typeof value.function.name === "string") {
    return value.function.name;
  }
  if (typeof value.name === "string" && value.name && value.type !== "text") {
    return value.name;
  }
  return "";
}

function argsJson(value) {
  if (!isRecord(value)) {
    return "{}";
  }
  var args = value.args;
  if (args == null && isRecord(value.function)) {
    args = value.function.arguments;
  }
  if (typeof args === "string") {
    return args || "{}";
  }
  if (args == null) {
    return "{}";
  }
  try {
    return JSON.stringify(args);
  } catch (err) {
    return "{}";
  }
}

function resultText(part) {
  if (!isRecord(part)) {
    return "";
  }
  var result = part.result !== undefined ? part.result : part.output;
  if (typeof result === "string") {
    return result;
  }
  if (result !== undefined) {
    try {
      return JSON.stringify(result);
    } catch (err) {
      return String(result);
    }
  }
  if (typeof part.content === "string") {
    return part.content;
  }
  try {
    return JSON.stringify(part);
  } catch (err) {
    return "";
  }
}

function asOpenAiToolCall(part, index) {
  var id = toolCallIdOf(part);
  if (!id && isRecord(part) && typeof part.id === "string" && part.id) {
    id = part.id;
  }
  if (!id) {
    id = "call_" + String(index);
  }
  return {
    id: id,
    type: "function",
    function: {
      name: toolNameOf(part),
      arguments: argsJson(part),
    },
  };
}

/** Peel host-injected reminder chrome. Never insert replacement text. */
function stripHostInjectedText(raw) {
  var s = String(raw == null ? "" : raw);
  s = s.replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, "");
  s = s.replace(/\[SAND_HIDDEN_PROMPT\][\s\S]*/g, "");
  return s;
}

function isBlankAfterHostChrome(text) {
  var s = stripHostInjectedText(text);
  s = s.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "");
  s = s.replace(/<user_query>([\s\S]*?)<\/user_query>/g, function (_all, inner) {
    return String(inner || "").trim();
  });
  s = s.replace(/<\/?user_query>/g, "");
  return s.trim() === "";
}

function contentToText(content) {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return JSON.stringify(content);
  }
  var bits = [];
  for (var i = 0; i < content.length; i++) {
    var p = content[i];
    if (p == null) {
      continue;
    }
    if (typeof p === "string") {
      bits.push(p);
    } else if (p.type === "text") {
      bits.push(p.text || "");
    } else if (p.type === "image") {
      bits.push("[image]");
    } else if (p.type === "tool-result") {
      bits.push(resultText(p));
    } else if (p.type === "tool-call") {
      continue;
    } else {
      bits.push(JSON.stringify(p));
    }
  }
  return bits.join("\n");
}

function convertParts(role, message, index) {
  var content = Array.isArray(message.content) ? message.content : [message.content];
  var texts = [];
  var calls = [];
  var results = [];
  for (var i = 0; i < content.length; i++) {
    var p = content[i];
    if (p == null) {
      continue;
    }
    if (typeof p === "string") {
      texts.push(p);
      continue;
    }
    if (!isRecord(p)) {
      continue;
    }
    if (p.type === "text") {
      texts.push(typeof p.text === "string" ? p.text : "");
      continue;
    }
    if (p.type === "image") {
      texts.push("[image]");
      continue;
    }
    if (p.type === "tool-call") {
      calls.push(asOpenAiToolCall(p, calls.length));
      continue;
    }
    if (p.type === "tool-result") {
      results.push(p);
      continue;
    }
    texts.push(JSON.stringify(p));
  }

  var out = [];
  var text = texts.join("\n");
  if (role === "user" || role === "system") {
    text = stripHostInjectedText(text);
  }
  var existingCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  var toolCalls = calls.length ? calls : existingCalls;

  if (role === "assistant" || toolCalls.length) {
    var assistant = { role: "assistant", content: text };
    if (toolCalls.length) {
      assistant.tool_calls = toolCalls;
    }
    out.push(assistant);
  } else if (role === "tool" && results.length === 0) {
    var row = { role: "tool", content: text };
    var id = toolCallIdOf(message);
    if (id) {
      row.tool_call_id = id;
    }
    out.push(row);
  } else if (role !== "tool" && (text || results.length === 0)) {
    if (!(role === "user" && isBlankAfterHostChrome(text))) {
      out.push({ role: role, content: text });
    }
  }

  for (var r = 0; r < results.length; r++) {
    var part = results[r];
    var toolRow = {
      role: "tool",
      content: resultText(part),
    };
    var toolId = toolCallIdOf(part) || toolCallIdOf(message);
    if (toolId) {
      toolRow.tool_call_id = toolId;
    }
    out.push(toolRow);
  }

  if (out.length === 0 && role !== "user") {
    out.push({ role: role === "tool" ? "tool" : "user", content: text });
  }
  return out;
}

function convertOne(message, index) {
  if (!isRecord(message)) {
    var raw = String(message || "");
    if (isBlankAfterHostChrome(raw)) {
      return [];
    }
    return [{ role: "user", content: stripHostInjectedText(raw) }];
  }
  var role = message.role;
  if (role === "function") {
    role = "tool";
  }
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    role = "user";
  }

  if (Array.isArray(message.content)) {
    return convertParts(role, message, index);
  }
  if (isRecord(message.content) && (message.content.type === "tool-result" || message.content.type === "tool-call")) {
    return convertParts(role, {
      role: role,
      content: [message.content],
      tool_calls: message.tool_calls,
      toolCallId: message.toolCallId,
      tool_call_id: message.tool_call_id,
    }, index);
  }

  var text = contentToText(message.content);
  if (role === "user" || role === "system") {
    text = stripHostInjectedText(text);
  }
  if (role === "user" && isBlankAfterHostChrome(text)) {
    return [];
  }

  var row = { role: role, content: text };
  if (role === "tool") {
    var id = toolCallIdOf(message);
    if (id) {
      row.tool_call_id = id;
    }
  }
  if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    row.tool_calls = message.tool_calls;
  }
  return [row];
}

function callIdsFromAssistant(row) {
  var ids = [];
  if (!row || !Array.isArray(row.tool_calls)) {
    return ids;
  }
  for (var i = 0; i < row.tool_calls.length; i++) {
    var call = row.tool_calls[i];
    if (call && typeof call.id === "string" && call.id) {
      ids.push(call.id);
    }
  }
  return ids;
}

function repairToolCallIds(messages) {
  var pending = [];
  for (var i = 0; i < messages.length; i++) {
    var row = messages[i];
    if (!row) {
      continue;
    }
    if (row.role === "assistant") {
      pending = callIdsFromAssistant(row).slice();
      continue;
    }
    if (row.role !== "tool") {
      continue;
    }
    if (typeof row.tool_call_id === "string" && row.tool_call_id.trim()) {
      var at = pending.indexOf(row.tool_call_id);
      if (at >= 0) {
        pending.splice(at, 1);
      }
      continue;
    }
    row.tool_call_id = pending.shift() || "call_" + String(i);
  }
  return messages;
}

function toOpenAIMessages(msgs) {
  if (!Array.isArray(msgs)) {
    var one = String(msgs || "");
    if (isBlankAfterHostChrome(one)) {
      return [{ role: "user", content: "" }];
    }
    return [{ role: "user", content: stripHostInjectedText(one) }];
  }
  var out = [];
  for (var i = 0; i < msgs.length; i++) {
    var rows = convertOne(msgs[i], i);
    for (var j = 0; j < rows.length; j++) {
      out.push(rows[j]);
    }
  }
  var repaired = repairToolCallIds(out);
  return repaired.length ? repaired : [{ role: "user", content: "" }];
}

exports.toOpenAIMessages = toOpenAIMessages;
exports.repairToolCallIds = repairToolCallIds;
exports.toolCallIdOf = toolCallIdOf;
exports.stripHostInjectedText = stripHostInjectedText;
exports.isBlankAfterHostChrome = isBlankAfterHostChrome;
