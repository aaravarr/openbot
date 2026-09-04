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
var os = require("os");
var path = require("path");
var { execFile } = require("child_process");
var PNG = require("pngjs").PNG;
var jpegJs = require("jpeg-js");

var MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB: reject absurdly large single images

// Injected images are compressed to keep the outbound request under the
// upstream gateway's hard 10 MiB body limit. Budget is 9 MiB for headroom.
var MAX_REQUEST_MESSAGE_BYTES = 9 * 1024 * 1024;

// Images at or below this size pass through untouched (keeps small PNGs sharp).
var SMALL_IMAGE_BYTES = 600 * 1024;

// Vision-model sweet spot: JPEG q85, long edge <= 1568px.
var DEFAULT_QUALITY = 85;
var DEFAULT_MAX_EDGE = 1568;

// Progressive degradation ladder when the request is still over budget:
// quality first, then size.
var DEGRADE_LEVELS = [
  { quality: 70, maxEdge: 1568 },
  { quality: 50, maxEdge: 1568 },
  { quality: 50, maxEdge: 1024 },
  { quality: 50, maxEdge: 768 },
];

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

// Sniff an image mime from magic bytes; "" when unknown. Shared with the
// host-part conversion in openai-messages.cjs.
function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return "";
  var b = buffer;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return "image/webp";
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return "image/gif";
  }
  return "";
}

function dataUrlFromBuffer(buffer, mime) {
  return "data:" + mime + ";base64," + buffer.toString("base64");
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

// --- Image compression (shared by Layer A and Layer B) ----------------------

function numberOr(value, fallback) {
  var n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function hasAlpha(rgba) {
  for (var i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return true;
  }
  return false;
}

function flattenOnWhite(rgba) {
  var out = Buffer.alloc(rgba.length);
  for (var i = 0; i < rgba.length; i += 4) {
    var a = rgba[i + 3] / 255;
    out[i] = Math.round(rgba[i] * a + 255 * (1 - a));
    out[i + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
    out[i + 2] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

function resizeRgba(src, sw, sh, dw, dh) {
  var dst = Buffer.alloc(dw * dh * 4);
  var xRatio = sw / dw;
  var yRatio = sh / dh;
  for (var y = 0; y < dh; y++) {
    var sy = y * yRatio;
    var y0 = Math.floor(sy);
    var y1 = Math.min(y0 + 1, sh - 1);
    var fy = sy - y0;
    var yRow = y * dw;
    for (var x = 0; x < dw; x++) {
      var sx = x * xRatio;
      var x0 = Math.floor(sx);
      var x1 = Math.min(x0 + 1, sw - 1);
      var fx = sx - x0;
      var i00 = (y0 * sw + x0) * 4;
      var i01 = (y0 * sw + x1) * 4;
      var i10 = (y1 * sw + x0) * 4;
      var i11 = (y1 * sw + x1) * 4;
      var di = (yRow + x) * 4;
      for (var c = 0; c < 4; c++) {
        var top = src[i00 + c] * (1 - fx) + src[i01 + c] * fx;
        var bot = src[i10 + c] * (1 - fx) + src[i11 + c] * fx;
        dst[di + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return dst;
}

function decodeToRgba(buffer, mime) {
  try {
    if (mime === "image/png") {
      var png = PNG.sync.read(buffer);
      return { width: png.width, height: png.height, data: Buffer.from(png.data) };
    }
    if (mime === "image/jpeg") {
      var jpg = jpegJs.decode(buffer, { useTArray: true, formatAsRGBA: true });
      return { width: jpg.width, height: jpg.height, data: Buffer.from(jpg.data) };
    }
  } catch (err) {
    return null;
  }
  return null; // webp/gif are not decodable in pure JS
}

// Re-encode a png/jpeg buffer to a resized JPEG. Returns a Buffer or null when
// the source cannot be decoded in pure JS (webp/gif) or the encode fails.
function encodeToJpeg(buffer, mime, opts) {
  var rgba = decodeToRgba(buffer, mime);
  if (!rgba) return null;
  var data = rgba.data;
  if (hasAlpha(data)) data = flattenOnWhite(data);
  var w = rgba.width;
  var h = rgba.height;
  var maxEdge = numberOr(opts.maxEdge, DEFAULT_MAX_EDGE);
  if (w > maxEdge || h > maxEdge) {
    var scale = maxEdge / Math.max(w, h);
    var dw = Math.max(1, Math.round(w * scale));
    var dh = Math.max(1, Math.round(h * scale));
    data = resizeRgba(data, w, h, dw, dh);
    w = dw;
    h = dh;
  }
  try {
    var encoded = jpegJs.encode({ data: data, width: w, height: h }, numberOr(opts.quality, DEFAULT_QUALITY));
    return Buffer.from(encoded.data);
  } catch (err) {
    return null;
  }
}

function mimeToExt(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".img";
}

function runExecFile(cmd, args) {
  return new Promise(function (resolve, reject) {
    execFile(cmd, args, { stdio: "ignore" }, function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Probe the box once for a system converter (ImageMagick `convert`, then
// `ffmpeg`) and cache the result. Used only for webp/gif, which pure JS cannot
// decode.
var systemConvertCommand; // undefined = unprobed, null = none, or "convert"/"ffmpeg"

async function probeSystemConverter() {
  var candidates = ["convert", "ffmpeg"];
  for (var i = 0; i < candidates.length; i++) {
    try {
      await runExecFile(candidates[i], ["-version"]);
      return candidates[i];
    } catch (err) {
      /* try the next one */
    }
  }
  return null;
}

async function getSystemConvertFn() {
  if (systemConvertCommand === undefined) {
    systemConvertCommand = await probeSystemConverter();
  }
  if (!systemConvertCommand) return null;
  var cmd = systemConvertCommand;
  return function (buffer, mime, opts) {
    return convertWithCommand(cmd, buffer, mime, opts);
  };
}

async function convertWithCommand(cmd, buffer, mime, opts) {
  var dir;
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openbot-img-"));
    var inPath = path.join(dir, "in" + mimeToExt(mime));
    var outPath = path.join(dir, "out.jpg");
    await fs.promises.writeFile(inPath, buffer);
    var maxEdge = numberOr(opts.maxEdge, DEFAULT_MAX_EDGE);
    var quality = numberOr(opts.quality, DEFAULT_QUALITY);
    if (cmd === "convert") {
      await runExecFile("convert", [
        inPath + "[0]", "-auto-orient", "-background", "white", "-flatten",
        "-resize", maxEdge + "x" + maxEdge + ">", "-quality", String(quality), outPath,
      ]);
    } else {
      await runExecFile("ffmpeg", [
        "-y", "-loglevel", "error", "-i", inPath,
        "-vf", "scale='min(" + maxEdge + ",iw)':-2",
        "-q:v", String(Math.max(2, Math.min(31, Math.round((100 - quality) / 6)))), outPath,
      ]);
    }
    var out = await fs.promises.readFile(outPath);
    return out.length ? { buffer: out, mime: "image/jpeg" } : null;
  } catch (err) {
    return null;
  } finally {
    if (dir) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch (err) {
        /* ignore */
      }
    }
  }
}

// Compress one image. Small images pass through; larger png/jpeg are re-encoded
// to JPEG (q85, long edge <= 1568, alpha flattened onto white). webp/gif use a
// system converter when present, otherwise pass through. Always keeps the
// smaller of original vs compressed.
async function prepareImageForModel(buffer, mime, options) {
  options = options || {};
  var quality = numberOr(options.quality, DEFAULT_QUALITY);
  var maxEdge = numberOr(options.maxEdge, DEFAULT_MAX_EDGE);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { buffer: buffer, mime: mime };
  }
  if (buffer.length <= SMALL_IMAGE_BYTES) {
    return { buffer: buffer, mime: mime };
  }

  var jpeg = encodeToJpeg(buffer, mime, { quality: quality, maxEdge: maxEdge });
  if (jpeg && jpeg.length < buffer.length) {
    return { buffer: jpeg, mime: "image/jpeg" };
  }

  var convertFn;
  if (options.convert === undefined) {
    convertFn = await getSystemConvertFn();
  } else {
    convertFn = options.convert; // null or an injected function
  }
  if (convertFn) {
    var conv = await convertFn(buffer, mime, { quality: quality, maxEdge: maxEdge });
    if (conv && Buffer.isBuffer(conv.buffer) && conv.buffer.length < buffer.length) {
      return { buffer: conv.buffer, mime: conv.mime || "image/jpeg" };
    }
  } else if (mime === "image/webp" || mime === "image/gif") {
    logLine("image-read: no system converter for " + mime + "; passing through");
  }
  return { buffer: buffer, mime: mime };
}

function parseDataUri(url) {
  if (typeof url !== "string" || url.indexOf("data:") !== 0) return null;
  var comma = url.indexOf(",");
  if (comma < 0) return null;
  var meta = url.slice(5, comma);
  var isBase64 = /;base64$/i.test(meta);
  var mime = meta.split(";")[0];
  var payload = url.slice(comma + 1);
  try {
    if (isBase64) {
      return { mime: mime, buffer: Buffer.from(payload, "base64") };
    }
    return { mime: mime, buffer: Buffer.from(decodeURIComponent(payload), "binary") };
  } catch (err) {
    return null;
  }
}

function collectDataUriImages(messages) {
  var out = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (!isRecord(msg) || !Array.isArray(msg.content)) continue;
    var content = msg.content;
    for (var j = 0; j < content.length; j++) {
      var part = content[j];
      if (!isRecord(part) || part.type !== "image_url") continue;
      var url = isRecord(part.image_url) ? part.image_url.url : "";
      var parsed = parseDataUri(url);
      if (!parsed || !/^image\//i.test(parsed.mime)) continue;
      out.push({
        contentArray: content,
        index: j,
        part: part,
        buffer: parsed.buffer,
        mime: parsed.mime,
        omitted: false,
      });
    }
  }
  return out;
}

function serializedBytes(messages) {
  try {
    return Buffer.byteLength(JSON.stringify(messages), "utf8");
  } catch (err) {
    return 0;
  }
}

async function encodeToJpegOrConvert(buffer, mime, level, convertFn) {
  var jpeg = encodeToJpeg(buffer, mime, level);
  if (jpeg) return { buffer: jpeg, mime: "image/jpeg" };
  if (convertFn) {
    var conv = await convertFn(buffer, mime, level);
    if (conv && Buffer.isBuffer(conv.buffer)) return { buffer: conv.buffer, mime: conv.mime || "image/jpeg" };
  }
  return null;
}

function applyImageResult(img, result, note) {
  var before = img.buffer.length;
  if (result && result.buffer.length < img.buffer.length) {
    img.buffer = result.buffer;
    img.mime = result.mime;
    img.part.image_url.url = dataUrlFromBuffer(result.buffer, result.mime);
    logLine(note + ": " + before + " -> " + img.buffer.length + " bytes");
    return true;
  }
  return false;
}

async function degradeToBudget(images, messages, budget, convertFn) {
  for (var li = 0; li < DEGRADE_LEVELS.length; li++) {
    if (serializedBytes(messages) <= budget) return;
    var level = DEGRADE_LEVELS[li];
    var order = images
      .filter(function (img) { return !img.omitted; })
      .sort(function (a, b) { return b.buffer.length - a.buffer.length; });
    for (var k = 0; k < order.length; k++) {
      if (serializedBytes(messages) <= budget) return;
      var img = order[k];
      var res = await encodeToJpegOrConvert(img.buffer, img.mime, level, convertFn);
      applyImageResult(img, res, "image-read degraded");
    }
  }
}

function omitToBudget(images, messages, budget) {
  // Least important = last in document order; keep the earliest images.
  for (var i = images.length - 1; i >= 0; i--) {
    if (serializedBytes(messages) <= budget) return;
    var img = images[i];
    if (img.omitted) continue;
    img.contentArray[img.index] = { type: "text", text: "[image omitted: budget]" };
    img.omitted = true;
    logLine("image-read omitted: budget exceeded");
  }
}

// Compress injected data-URI images, then enforce the 9 MiB request budget.
// http(s) image URLs are left untouched (they cost a few bytes, not image
// bytes). Never throws; a broken image degrades to a placeholder instead of
// failing the request.
async function enforceImageBudget(messages, options) {
  if (!Array.isArray(messages)) return messages;
  options = options || {};
  var budget = numberOr(options.budget, MAX_REQUEST_MESSAGE_BYTES);
  var convertFn;
  if (options.convert === undefined) {
    convertFn = await getSystemConvertFn();
  } else {
    convertFn = options.convert;
  }

  var images = collectDataUriImages(messages);
  if (images.length === 0) return messages;

  // 1. Normalize every image (small pass-through, large -> JPEG q85/1568).
  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    var res = await prepareImageForModel(img.buffer, img.mime, { convert: convertFn });
    applyImageResult(img, res, "image-read compressed");
  }

  // 2. Budget enforcement.
  if (serializedBytes(messages) > budget) {
    await degradeToBudget(images, messages, budget, convertFn);
  }
  if (serializedBytes(messages) > budget) {
    omitToBudget(images, messages, budget);
  }
  return messages;
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
  return { ok: true, dataUrl: dataUrlFromBuffer(buf, mime) };
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
exports.prepareImageForModel = prepareImageForModel;
exports.enforceImageBudget = enforceImageBudget;
exports.isImageReadToolName = isImageReadToolName;
exports.filePathFromArgs = filePathFromArgs;
exports.contentHasImageData = contentHasImageData;
exports.imageExtOf = imageExtOf;
exports.sniffImageMime = sniffImageMime;
exports.dataUrlFromBuffer = dataUrlFromBuffer;
exports.MAX_IMAGE_BYTES = MAX_IMAGE_BYTES;
exports.SMALL_IMAGE_BYTES = SMALL_IMAGE_BYTES;
exports.MAX_REQUEST_MESSAGE_BYTES = MAX_REQUEST_MESSAGE_BYTES;
exports.DEFAULT_MAX_EDGE = DEFAULT_MAX_EDGE;
