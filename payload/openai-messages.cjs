"use strict";

var fs = require("fs");
var { MAX_IMAGE_BYTES, sniffImageMime, dataUrlFromBuffer } = require("./image-read.cjs");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// --- Host image part -> OpenAI image_url ------------------------------------
//
// Grok Bot's host may attach an image part with an unspecified field shape.
// Probe tolerantly: raw base64 (`data`/`base64`, with a `mime`/`mimeType` field
// or sniffed from magic bytes), a `url` (http(s) or data: URI, used as-is), or
// a local `path`/`file` (read from disk, mime sniffed). On success we emit a
// standard `{ type: "image_url", image_url: { url } }` content part; on any
// failure we fall back to the old `"[image]"` placeholder so a broken image
// never fails the request.

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isDataUrl(value) {
  return typeof value === "string" && /^data:/i.test(value);
}

function tryDecodeBase64(value) {
  try {
    return Buffer.from(value, "base64");
  } catch (err) {
    return null;
  }
}

function tryReadImageFile(filePath) {
  var stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return "";
  }
  if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return "";
  var buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return "";
  }
  if (buf.length > MAX_IMAGE_BYTES) return "";
  var mime = sniffImageMime(buf);
  if (!mime) return "";
  return dataUrlFromBuffer(buf, mime);
}

function imageUrlFromPart(part) {
  if (!isRecord(part)) return "";
  // 1. raw base64 (data/base64), optionally with a mime/mimeType field.
  var raw = typeof part.data === "string" && part.data ? part.data : (typeof part.base64 === "string" ? part.base64 : "");
  if (raw) {
    if (isDataUrl(raw)) return raw;
    var buf = tryDecodeBase64(raw);
    if (!buf || buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return "";
    var mime = typeof part.mime === "string" ? part.mime : (typeof part.mimeType === "string" ? part.mimeType : "");
    if (!/^image\//i.test(mime)) mime = sniffImageMime(buf);
    if (!/^image\//i.test(mime)) return "";
    return dataUrlFromBuffer(buf, mime);
  }
  // 2. url: http(s) or data: URI, used as-is.
  var url = part.url;
  if (typeof url === "string" && (isHttpUrl(url) || isDataUrl(url))) return url;
  // 3. local path/file -> read from disk.
  var filePath = typeof part.path === "string" && part.path ? part.path : (typeof part.file === "string" ? part.file : "");
  if (filePath) {
    return tryReadImageFile(filePath);
  }
  return "";
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
      bits.push(imageUrlFromPart(p) || "[image]");
    } else if (p.type === "image_url") {
      bits.push(isRecord(p.image_url) && typeof p.image_url.url === "string" ? p.image_url.url : "[image]");
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

function userContent(text, images) {
  if (!images.length) return text;
  var content = [];
  if (text) content.push({ type: "text", text: text });
  for (var i = 0; i < images.length; i++) {
    content.push(images[i]);
  }
  return content;
}

function convertParts(role, message, index) {
  var content = Array.isArray(message.content) ? message.content : [message.content];
  var texts = [];
  var calls = [];
  var results = [];
  var images = [];
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
      var imageUrl = imageUrlFromPart(p);
      if (imageUrl) {
        images.push({ type: "image_url", image_url: { url: imageUrl } });
      } else {
        texts.push("[image]");
      }
      continue;
    }
    if (p.type === "image_url") {
      // Already-OpenAI image content (e.g. a second toOpenAIMessages pass on
      // the runtime->hop leg) must be preserved, not flattened into text.
      var existingUrl = isRecord(p.image_url) && typeof p.image_url.url === "string" ? p.image_url.url : "";
      if (existingUrl) {
        images.push({ type: "image_url", image_url: { url: existingUrl } });
      } else {
        texts.push("[image]");
      }
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
    out.push({ role: role, content: userContent(text, images) });
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

  if (out.length === 0) {
    out.push({ role: role === "tool" ? "tool" : role || "user", content: userContent(text, images) });
  }
  return out;
}

function convertOne(message, index) {
  if (!isRecord(message)) {
    return [{ role: "user", content: String(message || "") }];
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
    return [{ role: "user", content: String(msgs || "") }];
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
