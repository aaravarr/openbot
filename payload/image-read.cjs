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

// Compression libraries load lazily and are tolerated as missing: tarball
// installs ship no node_modules. Without them the hop still routes and the
// byte budget still applies (oversize images degrade to the omit placeholder);
// only the re-encoding is skipped. install.sh runs a best-effort
// `npm install --omit=dev` so real installs normally have them.
var imageLibs; // undefined = unprobed, null = unavailable, else { PNG, jpegJs }

function loadImageLibs() {
  if (imageLibs !== undefined) return imageLibs;
  try {
    imageLibs = { PNG: require("pngjs").PNG, jpegJs: require("jpeg-js") };
  } catch (err) {
    imageLibs = null;
    logLine("image-read: pngjs/jpeg-js not available; image compression is skipped (byte budget still enforced)");
  }
  return imageLibs;
}

var MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB: reject absurdly large single images

// Injected images are compressed so the outbound request stays inside the
// upstream provider's body limit. The fusion gateway edge allows 10 MiB, but
// its upstream rejected a real ~9.2 MB payload with 413 "Request Entity Too
// Large" (incident 2026-09-04, request a16ed054), so the binding limit lives
// below the gateway edge. Budget is 8 MiB on the serialized messages, measured
// in UTF-8 bytes, leaving >1 MiB of margin under that observed failure.
var MAX_REQUEST_MESSAGE_BYTES = 8 * 1024 * 1024;

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

// --- Layer C: harness-provided image bytes (experimental_content) -----------
//
// The official Read tool returns inline base64 image bytes on the tool result
// under `experimental_content` (aliases `experimentalContent` and plural
// forms). The conversion in openai-messages.cjs carries that raw value
// verbatim onto the emitted `role: "tool"` row so it survives the
// runtime -> hop round-trip; this module owns all probing and strips the
// carried keys before anything can reach upstream.

var EXPERIMENTAL_KEYS = [
  "experimental_content",
  "experimentalContent",
  "experimental_contents",
  "experimentalContents",
];

// Raw experimental content of a record, probing tolerant field aliases.
function experimentalContentRaw(record) {
  if (!isRecord(record)) return undefined;
  for (var i = 0; i < EXPERIMENTAL_KEYS.length; i++) {
    if (record[EXPERIMENTAL_KEYS[i]] !== undefined) return record[EXPERIMENTAL_KEYS[i]];
  }
  return undefined;
}

// Read the carried value off a converted row and delete every alias key, so it
// can never leak upstream regardless of what enrichment decides below.
function takeExperimentalContent(row) {
  var raw;
  for (var i = 0; i < EXPERIMENTAL_KEYS.length; i++) {
    var key = EXPERIMENTAL_KEYS[i];
    if (raw === undefined && row[key] !== undefined) raw = row[key];
    delete row[key];
  }
  return raw;
}

function isImageMime(mime) {
  return typeof mime === "string" && /^image\//i.test(mime);
}

function looksLikeImageUrlExt(value) {
  return typeof value === "string" && /\.(png|jpe?g|webp|gif)$/i.test(value);
}

function mimeHintFromRecord(record) {
  if (!isRecord(record)) return "";
  var hint = typeof record.mimeType === "string" ? record.mimeType : "";
  if (!hint && typeof record.mime === "string") hint = record.mime;
  if (!hint && isRecord(record.source) && typeof record.source.media_type === "string") {
    hint = record.source.media_type;
  }
  return hint;
}

function bytesFromValue(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

// Resolve one leaf value (data: URI, bare base64, raw bytes, or an http(s)
// image URL) to a normalized `{ url, mime }` entry, or null when it is not
// usable image data. `mimeHint` comes from sibling mimeType-style fields.
function imageEntryFromValue(value, mimeHint) {
  if (typeof value === "string" && value) {
    if (/^data:/i.test(value)) {
      var parsed = parseDataUri(value);
      if (!parsed || !Buffer.isBuffer(parsed.buffer) || parsed.buffer.length === 0) return null;
      if (parsed.buffer.length > MAX_IMAGE_BYTES) return null;
      if (isImageMime(parsed.mime)) return { url: value, mime: parsed.mime };
      // Odd or empty prefix: trust the decoded bytes instead.
      var sniffed = sniffImageMime(parsed.buffer);
      if (!isImageMime(sniffed)) return null;
      return { url: dataUrlFromBuffer(parsed.buffer, sniffed), mime: sniffed };
    }
    if (/^https?:\/\//i.test(value)) {
      // Only pass through remote URLs that name an image; never fetch here.
      if (isImageMime(mimeHint) || looksLikeImageUrlExt(value)) return { url: value, mime: "" };
      return null;
    }
    var bytes = Buffer.from(value, "base64");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    var mime = isImageMime(mimeHint) ? mimeHint : sniffImageMime(bytes);
    if (!isImageMime(mime)) return null;
    return { url: dataUrlFromBuffer(bytes, mime), mime: mime };
  }
  var raw = bytesFromValue(value);
  if (raw) {
    if (raw.length === 0 || raw.length > MAX_IMAGE_BYTES) return null;
    var m = isImageMime(mimeHint) ? mimeHint : sniffImageMime(raw);
    if (!isImageMime(m)) return null;
    return { url: dataUrlFromBuffer(raw, m), mime: m };
  }
  return null;
}

// Probe a tolerantly-shaped value for image data: records are walked through
// `image`/`data`/`base64`/`url`/`source` fields, arrays item by item, and
// strings/buffers resolved directly. Never throws; unknown shapes yield null.
function imageEntryFromAny(value, hint) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return imageEntryFromValue(value, hint);
  }
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var sub = imageEntryFromAny(value[i], hint);
      if (sub) return sub;
    }
    return null;
  }
  if (isRecord(value)) {
    var h = mimeHintFromRecord(value) || hint || "";
    var keys = ["image", "data", "base64", "url", "source"];
    for (var k = 0; k < keys.length; k++) {
      var entry = imageEntryFromAny(value[keys[k]], h);
      if (entry) return entry;
    }
  }
  return null;
}

// Extract normalized image entries from an experimental_content value (single
// item or array). Items whose own `type` names something other than "image"
// are skipped so text entries are never misread as image bytes.
function extractExperimentalImageUrls(value) {
  if (value === undefined || value === null) return [];
  var items = Array.isArray(value) ? value : [value];
  var out = [];
  var seen = Object.create(null);
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (isRecord(item) && typeof item.type === "string" && item.type && item.type !== "image") continue;
    var entry = imageEntryFromAny(item, "");
    if (!entry || seen[entry.url]) continue;
    seen[entry.url] = true;
    out.push(entry);
  }
  return out;
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
  var libs = loadImageLibs();
  if (!libs) return null;
  try {
    if (mime === "image/png") {
      var png = libs.PNG.sync.read(buffer);
      return { width: png.width, height: png.height, data: Buffer.from(png.data) };
    }
    if (mime === "image/jpeg") {
      var jpg = libs.jpegJs.decode(buffer, { useTArray: true, formatAsRGBA: true });
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
    var libs = loadImageLibs();
    if (!libs) return null;
    var encoded = libs.jpegJs.encode({ data: data, width: w, height: h }, numberOr(opts.quality, DEFAULT_QUALITY));
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
    // Degrade in document order: the oldest history images step down the
    // ladder first, so the newest images (typically the current turn's)
    // keep their quality the longest.
    var order = images.filter(function (img) {
      return !img.omitted && (img.appliedLevel === undefined || img.appliedLevel < li);
    });
    for (var k = 0; k < order.length; k++) {
      if (serializedBytes(messages) <= budget) return;
      var img = order[k];
      var res = await encodeToJpegOrConvert(img.buffer, img.mime, level, convertFn);
      if (applyImageResult(img, res, "image-read degraded")) img.appliedLevel = li;
    }
  }
}

function omitToBudget(images, messages, budget) {
  // Sacrifice in document order: the oldest history images are omitted
  // first, and the newest images (typically the current turn's) are kept
  // until nothing else fits.
  for (var i = 0; i < images.length; i++) {
    if (serializedBytes(messages) <= budget) return;
    var img = images[i];
    if (img.omitted) continue;
    img.contentArray[img.index] = { type: "text", text: "[image omitted: budget]" };
    img.omitted = true;
    logLine("image-read omitted: budget exceeded");
  }
}

// Compress injected data-URI images, then enforce the 8 MiB request budget.
// http(s) image URLs are left untouched (they cost a few bytes, not image
// bytes). Never throws; a broken image degrades to a placeholder instead of
// failing the request. A system converter is probed only when the budget pass
// actually needs one — pure-text and under-budget requests never spawn it.
async function enforceImageBudget(messages, options) {
  if (!Array.isArray(messages)) return messages;
  options = options || {};
  var budget = numberOr(options.budget, MAX_REQUEST_MESSAGE_BYTES);

  var images = collectDataUriImages(messages);
  if (images.length === 0) return messages;

  // 1. Normalize every image (small pass-through, large -> JPEG q85/1568).
  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    var res = await prepareImageForModel(img.buffer, img.mime, { convert: options.convert });
    applyImageResult(img, res, "image-read compressed");
  }

  // 2. Budget enforcement.
  if (serializedBytes(messages) > budget) {
    var convertFn = options.convert !== undefined ? options.convert : await getSystemConvertFn();
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

function imageMessageFor(label, dataUrl) {
  return {
    role: "user",
    content: [
      { type: "text", text: label },
      { type: "image_url", image_url: { url: dataUrl } },
    ],
  };
}

// Enrich an OpenAI-format message array. Tool results carrying harness image
// bytes (experimental_content) are mapped to the same injected user-message
// shape as disk reads; those bytes short-circuit Layer B, so the file is never
// re-read from disk and nothing is injected twice. Multiple images in one turn
// each get their own user message, placed immediately after the tool result
// they enrich.
async function enrichImageReads(messages) {
  if (!Array.isArray(messages)) return messages;

  // Strip carried experimental content from every row first: the hop never
  // forwards it upstream, whatever enrichment decides below.
  var experimentalByRow = new Map();
  for (var s = 0; s < messages.length; s++) {
    var row = messages[s];
    if (!isRecord(row)) continue;
    var raw = takeExperimentalContent(row);
    if (raw === undefined || row.role !== "tool") continue;
    var urls = extractExperimentalImageUrls(raw);
    if (urls.length) experimentalByRow.set(row, urls);
  }

  var imageCalls = collectImageReadCalls(messages);
  var out = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    out.push(msg);
    if (!isRecord(msg) || msg.role !== "tool") continue;
    // Image data already present in the result text means nothing is injected:
    // neither harness bytes nor a disk read (never double-inject).
    if (contentHasImageData(msg.content)) continue;
    var provided = experimentalByRow.get(msg);
    if (provided && provided.length) {
      var call = imageCalls[msg.tool_call_id];
      var label = call
        ? "[Image attached from Read: " + call.filePath + "]"
        : "[Image attached from tool result]";
      for (var k = 0; k < provided.length; k++) {
        out.push(imageMessageFor(label, provided[k].url));
      }
      logLine("image-read mapped " + provided.length + " harness image byte(s) after a tool result");
      continue; // harness bytes win; never read the file from disk here
    }
    var hit = imageCalls[msg.tool_call_id];
    if (!hit) continue;
    var read = await readImageDataUrl(hit.filePath);
    if (!read.ok) {
      logLine("image-read skipped: " + hit.filePath + " (" + read.reason + ")");
      continue;
    }
    out.push(imageMessageFor("[Image attached from Read: " + hit.filePath + "]", read.dataUrl));
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
exports.experimentalContentRaw = experimentalContentRaw;
exports.extractExperimentalImageUrls = extractExperimentalImageUrls;
exports.imageEntryFromAny = imageEntryFromAny;
exports.imageExtOf = imageExtOf;
exports.sniffImageMime = sniffImageMime;
exports.dataUrlFromBuffer = dataUrlFromBuffer;
exports.MAX_IMAGE_BYTES = MAX_IMAGE_BYTES;
exports.SMALL_IMAGE_BYTES = SMALL_IMAGE_BYTES;
exports.MAX_REQUEST_MESSAGE_BYTES = MAX_REQUEST_MESSAGE_BYTES;
exports.DEFAULT_MAX_EDGE = DEFAULT_MAX_EDGE;
