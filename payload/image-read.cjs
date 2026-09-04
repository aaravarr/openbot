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
// there. The official tap path never reaches it. After enrichment,
// `enforceImageBudget` governs the outbound body: byte-level dedup, a
// per-image history-turn size target, a current-turn image cap, and finally
// the 4 MiB outbound-wire budget — see "Active image governance" below.

var fs = require("fs");
var os = require("os");
var path = require("path");
var crypto = require("crypto");
var { execFile } = require("child_process");

// Compression libraries load lazily and are tolerated as missing. Resolution
// order: the vendored copies in `payload/vendor/` FIRST (they ship with every
// install, so a box with no npm registry access still compresses), then npm
// `node_modules` (source checkouts and CI). Without either, the hop still
// routes and the byte budget still applies (oversize images degrade to the
// omit placeholder); only the re-encoding is skipped.
var imageLibs; // undefined = unprobed, null = unavailable, else { PNG, jpegJs }
var imageLibsSource = "unavailable"; // "vendor" | "node_modules" | "unavailable"

// Returns { mod, source } for the first copy that loads, or null.
function loadCompressionModule(name, vendorRef) {
  try {
    return { mod: require(vendorRef), source: "vendor" };
  } catch (errVendor) {
    /* fall through to npm node_modules */
  }
  try {
    return { mod: require(name), source: "node_modules" };
  } catch (errNpm) {
    return null;
  }
}

function loadImageLibs() {
  if (imageLibs !== undefined) return imageLibs;
  var png = loadCompressionModule("pngjs", "./vendor/pngjs");
  var jpeg = loadCompressionModule("jpeg-js", "./vendor/jpeg-js");
  if (png && typeof png.mod.PNG === "function" && jpeg && jpeg.mod) {
    imageLibs = { PNG: png.mod.PNG, jpegJs: jpeg.mod };
    imageLibsSource = png.source === "vendor" && jpeg.source === "vendor" ? "vendor" : "node_modules";
  } else {
    imageLibs = null;
    imageLibsSource = "unavailable";
    logLine("image-read: pngjs/jpeg-js not available (bundled and npm); image compression is skipped (byte budget still enforced)");
  }
  return imageLibs;
}

var MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB: reject absurdly large single images

// The outbound wire is held under this limit. Three rounds of on-the-box
// forensics pinned the upstream limit: the fusion gateway edge allows 10 MiB
// (the old assumption), a ~9.2 MB body came back 413 while 4.43 MB succeeded
// (incident 2026-09-04, request a16ed054), and post-#53 bodies of 4.6-4.8 MB
// still 413'd — so the binding upstream limit lives in [4.43, 4.6) MB of wire
// and 8 MiB was measured against the wrong line. 4 MiB full-wire keeps every
// request under the proven-success ceiling with >0.2 MB of margin.
// The budget is measured on the FULL outbound wire — messages plus tools plus
// the rest of the request envelope — not on messages alone: the incident body
// crept just under a messages-only check and still 413'd once the ~230 KB of
// tools were added on top.
var MAX_REQUEST_WIRE_BYTES = 4 * 1024 * 1024;

// A little envelope grows AFTER image governance runs (max_tokens, provider
// parameter maps — together well under a hundred bytes). The hop adds this
// headroom on top of the measured envelope so the wire the upstream actually
// receives stays inside MAX_REQUEST_WIRE_BYTES.
var WIRE_HEADROOM_BYTES = 4 * 1024;

// Plain-text placeholders. No protocol fields are invented: each replaced
// image part simply becomes a text part the model can read.
var BUDGET_OMIT_PLACEHOLDER = "[image omitted: budget]";
var DEDUP_OMIT_PLACEHOLDER = "[image omitted: identical copy appears later in conversation]";
var CURRENT_TURN_IMAGE_OMIT_PLACEHOLDER = "[image omitted: current turn over image budget]";

// --- Active image governance (runs before the 4 MiB wire budget above) ------
//
// The 2026-09-04 incident (request a16ed054-4bac-49fd-89b9-cd75c38c797a) never
// tripped the then-8 MiB budget: the body carried 1,146 messages with 45
// injected data-URI JPEGs (all user role) worth ~8.3 MB of base64 on top of
// ~0.6 MB of text and ~0.23 MB of tools, and only ~26 of the 45 were distinct
// - the same screenshot had been re-read and re-injected turn after turn (one
// image x17, one x4, one x2), so the payload crept to just under the
// messages-only budget line and the upstream 413'd it (omitted_placeholders=0:
// the budget never fired). With the upstream limit now pinned to [4.43, 4.6)
// MB of wire, the budget alone is the last resort; the passes below shrink
// the request before the budget check runs, in this order:
//
//   dedup -> per-image history quota -> current-turn cap -> 4 MiB wire net
//
// HISTORY_IMAGE_TARGET_BYTES: every history-turn image larger than this is
// re-encoded down the JPEG ladder until it fits (or the ladder bottoms out).
// Calibrated at 88 KB decoded (~118 KB of data-URL) against the 4.2 MB
// worst-case target for the incident shape: 26 distinct history images at the
// target (26 x ~120 KB) + ~0.6 MB text + ~0.23 MB tools + the ~38 KB
// current-turn image + envelope ~= 4.0 MB <= 4.2 MB, itself >0.2 MB under the
// proven 4.43 MB success sample. (The first cut, 128 KB, capped that same
// shape at ~5.3 MB and missed; 96 KB still left the worst case at ~4.3 MB.)
// Real screenshots usually compress well below the target on the first ladder
// rung (q70, long edge 1568), so this binds hardest on photo-like images.
// Current-turn images are exempt here (they are the reason the request is
// being made).
var HISTORY_IMAGE_TARGET_BYTES = 88 * 1024;

// CURRENT_TURN_IMAGE_BUDGET_BYTES: hard cap on the summed data-URL bytes of
// the CURRENT turn's live images - the last real user message, its attached
// image parts, and the Read injections the hop places after it. Over the cap,
// current-turn images step down the existing degrade chain (oldest first
// inside the turn), then are omitted oldest-first; the last live current-turn
// image is never dropped - a fresh screenshot is the model's evidence, and a
// single-image turn always keeps exactly one copy. Calibrated at 3 MiB inside
// the 4 MiB wire budget: a maxed-out turn (3 MiB) plus the incident's ~0.84 MB
// of text/tools/envelope stays at ~3.9 MB wire, under the 4.43 MB success
// sample before any history image is even counted, and the wire net below
// then trims history (never the current turn, short of the last resort) to
// close the remaining gap. History images are governed by the per-image quota
// above, not by this cap.
var CURRENT_TURN_IMAGE_BUDGET_BYTES = 3 * 1024 * 1024;

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
  if (!hint && typeof record.mime_type === "string") hint = record.mime_type;
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
  // URL objects (observed as `image` payloads) resolve to their href string.
  if (typeof URL !== "undefined" && value instanceof URL) {
    try {
      return imageEntryFromValue(value.toString(), hint);
    } catch (err) {
      return null;
    }
  }
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
// smaller of original vs compressed. `options.cacheKey` (the source-bytes hash
// an image entry carries) routes the re-encode through the cross-request cache;
// only honored when quality/maxEdge are at their defaults, so custom encodes
// can never collide with a cached default-rung result.
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

  var cacheable = typeof options.cacheKey === "string" && options.cacheKey &&
    quality === DEFAULT_QUALITY && maxEdge === DEFAULT_MAX_EDGE;
  var jpeg = cacheable
    ? cachedEncodeToJpeg(buffer, mime, -1, { quality: quality, maxEdge: maxEdge }, options.cacheKey)
    : encodeToJpeg(buffer, mime, { quality: quality, maxEdge: maxEdge });
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
        messageIndex: i,
        contentArray: content,
        index: j,
        part: part,
        buffer: parsed.buffer,
        mime: parsed.mime,
        omitted: false,
        history: false,
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

// Re-encode results are cached across requests, keyed by source bytes (SHA-1),
// mime, and ladder rung. Governance runs on every hop request and a
// conversation re-sends the same history images every turn (the incident had
// one identical screenshot re-injected 17 times), so without the cache each
// round would re-encode every history image from scratch. Failed decodes are
// cached too (as null) so undecodable bytes do not pay a decode attempt per
// round. Bounded, evicting the oldest entry first.
var encodeCache = new Map(); // "<mime>|<levelIndex>|<sha1>" -> Buffer | null
var ENCODE_CACHE_MAX_ENTRIES = 128;

function cachedEncodeToJpeg(buffer, mime, levelIndex, level, hashHex) {
  var hash = typeof hashHex === "string" && hashHex
    ? hashHex
    : crypto.createHash("sha1").update(buffer).digest("hex");
  var key = mime + "|" + levelIndex + "|" + hash;
  if (encodeCache.has(key)) return encodeCache.get(key);
  var jpeg = encodeToJpeg(buffer, mime, level);
  if (encodeCache.size >= ENCODE_CACHE_MAX_ENTRIES) {
    encodeCache.delete(encodeCache.keys().next().value);
  }
  encodeCache.set(key, jpeg);
  return jpeg;
}

// One ladder rung for an image entry: cached pure-JS encode first, system
// converter (already probed or injected) as fallback.
async function encodeImageRung(img, levelIndex, level, convertFn) {
  var jpeg = cachedEncodeToJpeg(img.buffer, img.mime, levelIndex, level, img.hash);
  if (jpeg) return { buffer: jpeg, mime: "image/jpeg" };
  if (convertFn) {
    var conv = await convertFn(img.buffer, img.mime, level);
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
      var res = await encodeImageRung(img, li, level, convertFn);
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
    img.contentArray[img.index] = { type: "text", text: BUDGET_OMIT_PLACEHOLDER };
    img.omitted = true;
    logLine("image-read omitted: budget exceeded");
  }
}

// --- Active governance: dedup -> per-image history target -> current-turn
// cap. All three run before the 4 MiB wire budget above, so the budget check
// stays a last-resort net rather than the day-to-day clamp. -------------------

// User messages injected by enrichImageReads carry this label as their first
// text part. Turn classification skips them, so several same-turn injections
// (one per Read tool call) all count as current turn.
var INJECTED_IMAGE_LABEL_PREFIX = "[Image attached from";

function isInjectedImageMessage(msg) {
  if (!Array.isArray(msg.content) || msg.content.length === 0) return false;
  var first = msg.content[0];
  return isRecord(first) && first.type === "text" &&
    typeof first.text === "string" &&
    first.text.indexOf(INJECTED_IMAGE_LABEL_PREFIX) === 0;
}

// The current turn starts at the last user message that is not one of the
// hop's own injected image messages (the hop runs this after enrichment, so
// current-turn Read injections after it are included). Images before it are
// history turns.
function currentTurnStartIndex(messages) {
  for (var i = messages.length - 1; i >= 0; i--) {
    var msg = messages[i];
    if (isRecord(msg) && msg.role === "user" && !isInjectedImageMessage(msg)) return i;
  }
  return messages.length; // no user message: treat every image as history
}

// Wire cost of one live image: its data-URL string. Data URLs are pure ASCII
// (base64 + prefix), so string length equals UTF-8 bytes.
function imagePayloadBytes(img) {
  var url = img.part && img.part.image_url ? img.part.image_url.url : undefined;
  return typeof url === "string" ? url.length : 0;
}

function sumImagePayload(images, filter) {
  var sum = 0;
  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    if (img.omitted) continue;
    if (filter && !filter(img)) continue;
    sum += imagePayloadBytes(img);
  }
  return sum;
}

function totalImagePayloadBytes(images) {
  return sumImagePayload(images, null);
}

function currentTurnImagePayloadBytes(images) {
  return sumImagePayload(images, function (img) { return !img.history; });
}

function liveCurrentTurnCount(images) {
  var count = 0;
  for (var i = 0; i < images.length; i++) {
    if (!images[i].omitted && !images[i].history) count += 1;
  }
  return count;
}

// Byte-level dedup. Each image's decoded bytes are hashed; byte-identical
// copies are collapsed to the MOST RECENT occurrence (closest to the current
// turn, semantically the most relevant), and every earlier copy becomes a
// plain-text placeholder. Same screenshot re-read turn after turn used to
// inject one more full copy per turn; now only the latest copy is sent. Runs
// before any compression or budget check, so repeated history images never
// reach the ladder and never ride under a budget line: a user-attached image
// (current turn) also wins over an identical history copy this way.
function dedupImagesByHash(images) {
  var lastByHash = new Map();
  var replaced = 0;
  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    if (img.omitted) continue;
    var hash = crypto.createHash("sha1").update(img.buffer).digest("hex");
    img.hash = hash;
    var prev = lastByHash.get(hash);
    if (prev !== undefined) {
      prev.contentArray[prev.index] = { type: "text", text: DEDUP_OMIT_PLACEHOLDER };
      prev.omitted = true;
      replaced += 1;
    }
    lastByHash.set(hash, img);
  }
  return replaced;
}

// Step one image down the degradation ladder until it fits `target` or the
// ladder bottoms out; the smallest result wins (applyImageResult never
// regresses). Runs on history images only, starting past any rung already
// applied to this entry so repeated passes never stack generation loss.
async function compressImageToTarget(img, target, convertFn, note) {
  for (var li = img.appliedLevel === undefined ? 0 : img.appliedLevel + 1; li < DEGRADE_LEVELS.length; li++) {
    if (img.omitted || img.buffer.length <= target) return;
    var res = await encodeImageRung(img, li, DEGRADE_LEVELS[li], convertFn);
    if (applyImageResult(img, res, note)) img.appliedLevel = li;
  }
}

// Current-turn cap, phase 1: squeeze the current turn's live images down the
// existing degrade chain, oldest first, until the summed payload fits the cap.
async function degradeCurrentTurnToBudget(images, budget, convertFn) {
  for (var li = 0; li < DEGRADE_LEVELS.length; li++) {
    if (currentTurnImagePayloadBytes(images) <= budget) return;
    var order = images.filter(function (img) {
      return !img.history && !img.omitted && (img.appliedLevel === undefined || img.appliedLevel < li);
    });
    for (var k = 0; k < order.length; k++) {
      if (currentTurnImagePayloadBytes(images) <= budget) return;
      var img = order[k];
      var res = await encodeImageRung(img, li, DEGRADE_LEVELS[li], convertFn);
      if (applyImageResult(img, res, "image-read current-turn degraded")) img.appliedLevel = li;
    }
  }
}

// Current-turn cap, phase 2: omit current-turn images oldest-first while the
// cap is still exceeded AND more than one live image remains in the turn —
// the newest copy of what the user just sent is the model's evidence and is
// never dropped, so a single-image current turn always keeps its image.
function omitCurrentTurnToBudget(images, budget) {
  for (var i = 0; i < images.length; i++) {
    if (currentTurnImagePayloadBytes(images) <= budget) return;
    var img = images[i];
    if (img.omitted || img.history) continue;
    if (liveCurrentTurnCount(images) <= 1) return;
    img.contentArray[img.index] = { type: "text", text: CURRENT_TURN_IMAGE_OMIT_PLACEHOLDER };
    img.omitted = true;
    logLine("image-read omitted: current turn over image budget");
  }
}

// Compress injected data-URI images, then hold the request inside the
// governance limits. Order: byte-level dedup -> per-image history target ->
// current-turn image cap -> outbound-wire budget (degrade then omit, oldest
// first). The wire budget is measured by the caller: `options.extraWireBytes`
// carries the serialized size of everything the outbound body carries besides
// messages (tools, model, stream and the other envelope fields), so the
// invariant is on the full wire the upstream receives, not on messages alone.
// http(s) image URLs are left untouched (they cost a few bytes, not image
// bytes). Never throws; a broken image degrades to a placeholder instead of
// failing the request. The system converter is probed at most once per
// process and only when an image pass runs — pure-text and under-limit
// requests never spawn it.
async function enforceImageBudget(messages, options) {
  if (!Array.isArray(messages)) return messages;
  options = options || {};
  var wireBudget = numberOr(options.budget, MAX_REQUEST_WIRE_BYTES);
  var historyTarget = numberOr(options.historyTarget, HISTORY_IMAGE_TARGET_BYTES);
  var currentTurnBudget = numberOr(options.currentTurnBudget, CURRENT_TURN_IMAGE_BUDGET_BYTES);
  var extraWireBytes = Number(options.extraWireBytes);
  if (!Number.isFinite(extraWireBytes) || extraWireBytes < 0) extraWireBytes = 0;
  var budget = wireBudget - extraWireBytes;

  var images = collectDataUriImages(messages);
  if (images.length === 0) return messages;

  // 1. Byte-level dedup, before any compression or budget check.
  var deduped = dedupImagesByHash(images);
  if (deduped > 0) {
    logLine("image-read deduped " + deduped + " duplicate image copy(ies); kept the most recent of each");
  }

  // 2. Normalize every live image (small pass-through, large -> JPEG q85/1568).
  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    if (img.omitted) continue;
    var res = await prepareImageForModel(img.buffer, img.mime, { convert: options.convert, cacheKey: img.hash });
    applyImageResult(img, res, "image-read compressed");
  }

  // 3. Per-image history target: history images above the target step down
  // the ladder; current-turn images keep the pre-existing behavior.
  var boundary = currentTurnStartIndex(messages);
  var historyImages = [];
  for (var h = 0; h < images.length; h++) {
    images[h].history = images[h].messageIndex < boundary;
    if (images[h].history && !images[h].omitted && images[h].buffer.length > historyTarget) {
      historyImages.push(images[h]);
    }
  }
  if (historyImages.length > 0) {
    var historyConvertFn = options.convert !== undefined ? options.convert : await getSystemConvertFn();
    for (var t = 0; t < historyImages.length; t++) {
      await compressImageToTarget(historyImages[t], historyTarget, historyConvertFn, "image-read history compressed");
    }
  }

  // 4. Current-turn cap: squeeze the turn's own images down the degrade chain
  // (oldest first inside the turn), then omit oldest-first. The last live
  // current-turn image is never dropped here; the wire net below stays the
  // final resort for anything that still does not fit.
  if (currentTurnImagePayloadBytes(images) > currentTurnBudget) {
    var turnConvertFn = options.convert !== undefined ? options.convert : await getSystemConvertFn();
    await degradeCurrentTurnToBudget(images, currentTurnBudget, turnConvertFn);
    omitCurrentTurnToBudget(images, currentTurnBudget);
  }

  // 5. Wire budget: final safety net over messages + extraWireBytes, unchanged
  // degrade-then-omit semantics and oldest-first sacrifice order (PR #53).
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
exports.currentTurnStartIndex = currentTurnStartIndex;
exports.dedupImagesByHash = dedupImagesByHash;
exports.totalImagePayloadBytes = totalImagePayloadBytes;
exports.currentTurnImagePayloadBytes = currentTurnImagePayloadBytes;
exports.MAX_IMAGE_BYTES = MAX_IMAGE_BYTES;
exports.SMALL_IMAGE_BYTES = SMALL_IMAGE_BYTES;
exports.MAX_REQUEST_WIRE_BYTES = MAX_REQUEST_WIRE_BYTES;
exports.WIRE_HEADROOM_BYTES = WIRE_HEADROOM_BYTES;
exports.HISTORY_IMAGE_TARGET_BYTES = HISTORY_IMAGE_TARGET_BYTES;
exports.CURRENT_TURN_IMAGE_BUDGET_BYTES = CURRENT_TURN_IMAGE_BUDGET_BYTES;
exports.BUDGET_OMIT_PLACEHOLDER = BUDGET_OMIT_PLACEHOLDER;
exports.DEDUP_OMIT_PLACEHOLDER = DEDUP_OMIT_PLACEHOLDER;
exports.CURRENT_TURN_IMAGE_OMIT_PLACEHOLDER = CURRENT_TURN_IMAGE_OMIT_PLACEHOLDER;
exports.isInjectedImageMessage = isInjectedImageMessage;
// "vendor" | "node_modules" | "unavailable" — probes the lazy loader once.
exports.imageLibsSource = function () {
  loadImageLibs();
  return imageLibsSource;
};
exports.DEFAULT_MAX_EDGE = DEFAULT_MAX_EDGE;
