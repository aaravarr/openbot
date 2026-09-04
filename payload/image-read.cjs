"use strict";

// Image-read enrichment for the hop path only.
//
// When a conversation contains a Read-style tool call that targets an image
// file, and the matching `role: "tool"` result carries no image data, the hop
// itself reads the file from disk and injects a follow-up `role: "user"`
// message (standard OpenAI image content) immediately after that tool result.
// Upstream models do not reliably accept image data on tool-result messages,
// so a user-message image is the compatible shape.
//
// This pass runs in payload/hop-handler.cjs AFTER `toOpenAIMessages`, and only
// there. The official tap path never reaches it.

var fs = require("fs");

var MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

var IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp|gif)$/i;

var MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function imageExtOf(filePath) {
  if (typeof filePath !== "string") return "";
  var match = filePath.match(IMAGE_EXT_RE);
  return match ? match[1].toLowerCase() : "";
}

function isImageReadToolName(name) {
  if (typeof name !== "string") return false;
  var normalized = name.trim().toLowerCase();
  if (normalized === "read" || normalized === "readimage") return true;
  // read_image, read-image, read image, Read_Image, ...
  return /^read[-_\s]?image$/.test(normalized);
}

function filePathFromArgs(argumentsRaw) {
  if (typeof argumentsRaw !== "string") return "";
  var parsed;
  try {
    parsed = JSON.parse(argumentsRaw || "{}");
  } catch (err) {
    return "";
  }
  if (!isRecord(parsed)) return "";
  var candidate = parsed.path !== undefined ? parsed.path : parsed.file_path;
  return typeof candidate === "string" ? candidate : "";
}

function contentText(content) {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch (err) {
    return String(content);
  }
}

function contentHasImageData(content) {
  var text = contentText(content) || "";
  if (text.indexOf("image_url") !== -1) return true;
  // Any data: URI (e.g. data:image/png;base64,...) already present counts as
  // image data; do not double-inject.
  return /data:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,]/i.test(text);
}

function logLine(message) {
  try {
    process.stderr.write("openbot-hop " + message + "\n");
  } catch (err) {
    /* never throw on logging */
  }
}

async function readImageDataUrl(filePath) {
  var stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err) {
    return { ok: false, reason: "missing" };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: "not-a-file" };
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  var buf;
  try {
    buf = await fs.promises.readFile(filePath);
  } catch (err) {
    return { ok: false, reason: "unreadable" };
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  var ext = imageExtOf(filePath);
  var mime = MIME_BY_EXT[ext] || "image/png";
  return { ok: true, dataUrl: "data:" + mime + ";base64," + buf.toString("base64") };
}

// Build tool_call_id -> { filePath } for assistant tool_calls that are image
// reads (read/read_image + image-extension path).
function collectImageReadCalls(messages) {
  var map = Object.create(null);
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (!isRecord(msg) || msg.role !== "assistant") continue;
    var calls = msg.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (var j = 0; j < calls.length; j++) {
      var call = calls[j];
      if (!isRecord(call)) continue;
      var fn = isRecord(call.function) ? call.function : {};
      if (!isImageReadToolName(fn.name)) continue;
      var filePath = filePathFromArgs(fn.arguments);
      if (!imageExtOf(filePath)) continue;
      if (typeof call.id === "string" && call.id) {
        map[call.id] = { filePath: filePath };
      }
    }
  }
  return map;
}

function imageMessageFor(filePath, dataUrl) {
  return {
    role: "user",
    content: [
      { type: "text", text: "[Image attached from Read: " + filePath + "]" },
      { type: "image_url", image_url: { url: dataUrl } },
    ],
  };
}

// Enrich an OpenAI-format message array. Multiple matching images in one turn
// each get their own user message, placed immediately after the tool result
// they enrich.
async function enrichImageReads(messages) {
  if (!Array.isArray(messages)) return messages;
  var imageCalls = collectImageReadCalls(messages);
  var out = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    out.push(msg);
    if (!isRecord(msg) || msg.role !== "tool") continue;
    var hit = imageCalls[msg.tool_call_id];
    if (!hit) continue;
    if (contentHasImageData(msg.content)) continue;
    var read = await readImageDataUrl(hit.filePath);
    if (!read.ok) {
      logLine("image-read skipped: " + hit.filePath + " (" + read.reason + ")");
      continue;
    }
    out.push(imageMessageFor(hit.filePath, read.dataUrl));
    logLine("image-read enriched: " + hit.filePath);
  }
  return out;
}

exports.enrichImageReads = enrichImageReads;
exports.isImageReadToolName = isImageReadToolName;
exports.filePathFromArgs = filePathFromArgs;
exports.contentHasImageData = contentHasImageData;
exports.imageExtOf = imageExtOf;
exports.MAX_IMAGE_BYTES = MAX_IMAGE_BYTES;
