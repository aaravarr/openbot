"use strict";

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

var PREVIEW_CHARS = 8000;
var ERROR_CHARS = 500;
var DEFAULT_SAND_DATA = "/home/box/sand-data";
var CACHE_TTL_MS = 60 * 1000;
var MAX_TOTAL_COUNT = 1000;
var FACETS_SAMPLE_LIMIT = 5000;
var FACETS_MAX_OPTIONS = 200;
var PRUNE_BATCH = 200;
// A body file whose id never appeared in the log file may be mid-write from
// another process ("body first, row second"). Only reap it once it is older
// than this grace window. Bodies of rows that were pruned away are deleted
// immediately: their id can never be appended again.
var ORPHAN_GRACE_MS = 10 * 60 * 1000;
var PRUNE_LOCK_NAME = "openbot-requests.lock";
var PRUNE_LOCK_STALE_MS = 60 * 1000;
var PRUNE_LOCK_WAIT_MS = 15 * 1000;
var PRUNE_LOCK_WAIT_ASYNC_MS = 2000;
var MAX_EVENT_BYTES = 4 * 1000 * 1000;
var MAX_EVENT_KEPT = 500;
var STATS_DISK_SCAN_CAP = 5000;
var APPROX_BYTES_PER_ROW = 400;

var DEFAULTS = {
  loggingEnabled: false,
  logBodies: false,
  logBodiesOnError: true,
  logRetentionDays: 7,
  maxBodyCaptureBytes: 65536,
  // Deprecated: read-compat only. Retention is date-based (logRetentionDays);
  // no count cap is enforced anywhere anymore.
  maxRecords: 2000,
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sandDataDir() {
  if (process.env.OPENBOT_SAND_DATA) return process.env.OPENBOT_SAND_DATA;
  if (process.env.OPENBOT_PLAN) return path.dirname(process.env.OPENBOT_PLAN);
  return DEFAULT_SAND_DATA;
}

function logPaths() {
  var sand = sandDataDir();
  return {
    sandData: sand,
    settings: process.env.OPENBOT_LOGS || path.join(sand, "openbot-logs.json"),
    requestLog: path.join(sand, "openbot-requests.jsonl"),
    eventsLog: path.join(sand, "openbot-events.jsonl"),
    bodiesDir: path.join(sand, "openbot-request-bodies"),
    secrets: process.env.OPENBOT_SECRETS || path.join(sand, "secrets.json"),
  };
}

function cutoffForRetention(retentionDays) {
  var days = Math.max(1, Math.floor(Number(retentionDays) || DEFAULTS.logRetentionDays));
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

function asBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function integerInRange(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error("OpenBot: " + label + " must be an integer between " + min + " and " + max);
  }
  return value;
}

function asOptionalInt(value, min, max, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    value = Number(value);
  }
  return integerInRange(value, min, max, label);
}

function normalizeSettings(raw, fallback) {
  var base = fallback || DEFAULTS;
  var src = isRecord(raw) ? raw : {};
  return {
    loggingEnabled: asBoolean(src.loggingEnabled, base.loggingEnabled),
    logBodies: asBoolean(src.logBodies, base.logBodies),
    logBodiesOnError: asBoolean(src.logBodiesOnError, base.logBodiesOnError),
    logRetentionDays: asOptionalInt(src.logRetentionDays, 1, 365, base.logRetentionDays, "Log retention days"),
    maxBodyCaptureBytes: asOptionalInt(
      src.maxBodyCaptureBytes,
      1024,
      1048576,
      base.maxBodyCaptureBytes,
      "Max body capture bytes",
    ),
    // Deprecated (read-compat only): accepted and echoed back, never enforced.
    maxRecords: asOptionalInt(src.maxRecords, 1, 10000, base.maxRecords, "Max records"),
  };
}

function loadSettings() {
  try {
    var file = logPaths().settings;
    var text = fs.readFileSync(file, "utf8");
    return normalizeSettings(JSON.parse(text), DEFAULTS);
  } catch (err) {
    return {
      loggingEnabled: DEFAULTS.loggingEnabled,
      logBodies: DEFAULTS.logBodies,
      logBodiesOnError: DEFAULTS.logBodiesOnError,
      logRetentionDays: DEFAULTS.logRetentionDays,
      maxBodyCaptureBytes: DEFAULTS.maxBodyCaptureBytes,
      maxRecords: DEFAULTS.maxRecords,
    };
  }
}

function saveSettings(input) {
  var next = normalizeSettings(input, loadSettings());
  // Deprecated (read-compat only): maxRecords is never enforced anywhere, so
  // it is never persisted. The settings PUT API drops the field before it
  // even reaches here; this is the second net for direct callers.
  delete next.maxRecords;
  var file = logPaths().settings;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8");
  try {
    pruneNow(next);
  } catch (err) {
    /* prune is best-effort */
  }
  invalidateAggregates();
  return next;
}

function secretValues() {
  try {
    var store = JSON.parse(fs.readFileSync(logPaths().secrets, "utf8"));
    var providers = store && store.providers;
    if (!isRecord(providers)) return [];
    var out = [];
    var keys = Object.keys(providers);
    for (var i = 0; i < keys.length; i++) {
      var value = providers[keys[i]];
      if (typeof value === "string" && value.length > 0) out.push(value);
    }
    return out;
  } catch (err) {
    return [];
  }
}

var TOKEN_RE = /(?:sk-or-|sk-|ocg_)[A-Za-z0-9_\-]+/g;
var BEARER_RE = /Bearer\s+\S+/gi;

function redactString(text, secrets) {
  var out = String(text);
  if (!out) return out;
  var list = secrets || [];
  for (var i = 0; i < list.length; i++) {
    var secret = list[i];
    if (!secret) continue;
    if (out.indexOf(secret) !== -1) {
      out = out.split(secret).join("[redacted]");
    }
  }
  out = out.replace(BEARER_RE, "Bearer [redacted]");
  out = out.replace(TOKEN_RE, "[redacted]");
  return out;
}

function redact(value, secrets) {
  var list = secrets || secretValues();
  if (typeof value === "string") return redactString(value, list);
  if (Array.isArray(value)) {
    var rows = [];
    for (var i = 0; i < value.length; i++) rows.push(redact(value[i], list));
    return rows;
  }
  if (isRecord(value)) {
    var out = {};
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (/^authorization$/i.test(key) || /^api[-_]?key$/i.test(key) || /^x-api-key$/i.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = redact(value[key], list);
      }
    }
    return out;
  }
  return value;
}

function tryParseJson(text) {
  if (typeof text !== "string") return undefined;
  var trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    return undefined;
  }
}

function extractBodyError(payload) {
  if (typeof payload === "string") {
    var parsed = tryParseJson(payload);
    if (parsed !== undefined) return extractBodyError(parsed);
    if (payload.indexOf("data:") !== -1) return extractSseError(payload);
    var text = payload.trim();
    return text ? text.slice(0, ERROR_CHARS) : undefined;
  }
  if (!isRecord(payload)) return undefined;
  var err = payload.error;
  if (typeof err === "string" && err.trim()) return err.trim().slice(0, ERROR_CHARS);
  if (isRecord(err)) {
    if (typeof err.message === "string" && err.message.trim()) return err.message.trim().slice(0, ERROR_CHARS);
    if (typeof err.msg === "string" && err.msg.trim()) return err.msg.trim().slice(0, ERROR_CHARS);
  }
  if (typeof payload.message === "string" && payload.message.trim() && payload.choices === undefined) {
    return payload.message.trim().slice(0, ERROR_CHARS);
  }
  return undefined;
}

function extractSseError(text) {
  if (typeof text !== "string" || text.indexOf("data:") === -1) return undefined;
  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || line.indexOf("data:") !== 0) continue;
    var data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    var parsed = tryParseJson(data);
    if (!isRecord(parsed) || !Object.prototype.hasOwnProperty.call(parsed, "error")) continue;
    var found = extractBodyError(parsed);
    if (found) return found;
  }
  return undefined;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Rich usage reader (mirrors opencode-api capture.ts): understands OpenAI
// chat/responses, Anthropic messages and DeepSeek-style cache dialects, plus
// reasoning / text / image / audio splits. Old prompt/completion/total keys
// keep their meaning; the rest is purely additive.
function readUsageObject(usage, fallback) {
  if (!isRecord(usage)) return undefined;
  var promptTokensRaw = num(usage.prompt_tokens) ?? num(usage.input_tokens) ?? num(usage.promptTokens);
  var completionTokens =
    num(usage.completion_tokens) ?? num(usage.output_tokens) ?? num(usage.completionTokens);
  var totalTokens = num(usage.total_tokens) ?? num(usage.totalTokens);
  var promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  var inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  var completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : undefined;
  var outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  var cacheRead = num(usage.cache_read_input_tokens);
  var cachedTokens =
    num(usage.cached_tokens) ??
    cacheRead ??
    (promptDetails ? num(promptDetails.cached_tokens) : undefined) ??
    (inputDetails ? num(inputDetails.cached_tokens) : undefined) ??
    num(usage.prompt_cache_hit_tokens) ??
    (isRecord(fallback) ? num(fallback.cached_tokens) : undefined);
  // Anthropic's input_tokens excludes cache reads: add them back so prompt
  // totals share one definition across providers.
  var promptTokens =
    promptTokensRaw !== undefined && (cacheRead || 0) > 0 ? promptTokensRaw + cacheRead : promptTokensRaw;
  var reasoningTokens =
    num(usage.reasoning_tokens) ??
    (completionDetails ? num(completionDetails.reasoning_tokens) : undefined) ??
    (outputDetails ? num(outputDetails.reasoning_tokens) : undefined) ??
    (completionDetails ? num(completionDetails.reasoning_output_tokens) : undefined) ??
    (outputDetails ? num(outputDetails.reasoning_output_tokens) : undefined) ??
    num(usage.reasoning_output_tokens) ??
    (isRecord(fallback)
      ? num(fallback.reasoning_tokens) ?? num(fallback.reasoning_output_tokens)
      : undefined);
  var textTokens =
    num(usage.text_tokens) ??
    (completionDetails ? num(completionDetails.text_tokens) : undefined) ??
    (outputDetails ? num(outputDetails.text_tokens) : undefined) ??
    (isRecord(fallback) ? num(fallback.text_tokens) : undefined);
  var imageTokens = num(usage.image_tokens);
  var audioTokens = num(usage.audio_tokens);
  var computed =
    totalTokens ??
    (promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined);
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    computed === undefined &&
    cachedTokens === undefined &&
    reasoningTokens === undefined &&
    textTokens === undefined &&
    imageTokens === undefined &&
    audioTokens === undefined
  ) {
    return undefined;
  }
  var out = {};
  if (promptTokens !== undefined) out.promptTokens = promptTokens;
  if (completionTokens !== undefined) out.completionTokens = completionTokens;
  if (computed !== undefined) out.totalTokens = computed;
  if (cachedTokens !== undefined) out.cachedTokens = cachedTokens;
  if (reasoningTokens !== undefined) out.reasoningTokens = reasoningTokens;
  if (textTokens !== undefined) out.textTokens = textTokens;
  if (imageTokens !== undefined) out.imageTokens = imageTokens;
  if (audioTokens !== undefined) out.audioTokens = audioTokens;
  return out;
}

function isUsageLikeObject(value) {
  if (!isRecord(value)) return false;
  var hasIn = typeof value.prompt_tokens === "number" || typeof value.input_tokens === "number";
  var hasOut = typeof value.completion_tokens === "number" || typeof value.output_tokens === "number";
  return hasIn && hasOut;
}

function extractUsage(payload) {
  if (!isRecord(payload)) return undefined;
  var candidates = [];
  if (payload.usage !== undefined) candidates.push(payload.usage);
  if (isRecord(payload.message) && payload.message.usage !== undefined) {
    candidates.push(payload.message.usage);
  }
  if (isRecord(payload.response)) {
    if (payload.response.usage !== undefined) candidates.push(payload.response.usage);
    if (isRecord(payload.response.response) && payload.response.response.usage !== undefined) {
      candidates.push(payload.response.response.usage);
    }
  }
  if (Array.isArray(payload.choices)) {
    for (var i = 0; i < payload.choices.length; i++) {
      var choice = payload.choices[i];
      if (isRecord(choice) && isRecord(choice.usage)) candidates.push(choice.usage);
    }
  }
  // Bare usage events (a usage object with no "usage" wrapper key).
  if (isUsageLikeObject(payload)) candidates.push(payload);
  for (var c = 0; c < candidates.length; c++) {
    var parsed = readUsageObject(candidates[c], payload);
    if (parsed) return parsed;
  }
  return undefined;
}

// Field-level merge for streams that emit several usage frames: some
// upstreams send reasoning/cached counts first and bare counts last, so
// whole-object last-wins would wipe the earlier detail.
function mergeUsage(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  return {
    promptTokens: next.promptTokens !== undefined ? next.promptTokens : prev.promptTokens,
    completionTokens: next.completionTokens !== undefined ? next.completionTokens : prev.completionTokens,
    totalTokens: next.totalTokens !== undefined ? next.totalTokens : prev.totalTokens,
    cachedTokens: next.cachedTokens !== undefined ? next.cachedTokens : prev.cachedTokens,
    textTokens: next.textTokens !== undefined ? next.textTokens : prev.textTokens,
    imageTokens: next.imageTokens !== undefined ? next.imageTokens : prev.imageTokens,
    audioTokens: next.audioTokens !== undefined ? next.audioTokens : prev.audioTokens,
    reasoningTokens: next.reasoningTokens !== undefined ? next.reasoningTokens : prev.reasoningTokens,
  };
}

function extractUsageFromSse(text) {
  if (typeof text !== "string" || text.indexOf("data:") === -1) return undefined;
  var merged;
  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || line.indexOf("data:") !== 0) continue;
    var data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    var parsed = tryParseJson(data);
    var usage = extractUsage(parsed);
    if (usage) merged = mergeUsage(merged, usage);
  }
  return merged;
}

// First-content-chunk test for streams: any real model output (content /
// reasoning / thinking / text / delta / tool_calls). A bare role-only frame
// does not count. Mirrors opencode-api capture.ts.
var SSE_CONTENT_KEYS = ["content", "reasoning_content", "reasoning", "thinking", "text", "delta"];

function sseChunkHasContent(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      if (sseChunkHasContent(value[i])) return true;
    }
    return false;
  }
  var obj = value;
  for (var k = 0; k < SSE_CONTENT_KEYS.length; k++) {
    if (typeof obj[SSE_CONTENT_KEYS[k]] === "string" && obj[SSE_CONTENT_KEYS[k]].length > 0) return true;
  }
  if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) return true;
  var keys = Object.keys(obj);
  for (var j = 0; j < keys.length; j++) {
    var child = obj[keys[j]];
    if (child && typeof child === "object" && sseChunkHasContent(child)) return true;
  }
  return false;
}

// Rebuild a display-ready response object out of SSE text: chat deltas are
// aggregated per choice (content + reasoning + tool_calls), responses-style
// completed events win when present. Raw SSE is unreadable in the UI, which
// used to surface as "blank" bodies even though bytes were on disk.
function extractResponseFromSse(text) {
  if (typeof text !== "string" || text.indexOf("data:") === -1) return undefined;
  var completed;
  var lastResponseLike;
  var lastChatChunk;
  var chatAgg = {};
  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || line.indexOf("data:") !== 0) continue;
    var data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    var parsed;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed.type === "response.completed" && isRecord(parsed.response)) {
      completed = parsed.response;
      continue;
    }
    if (parsed.object === "response" && Array.isArray(parsed.output)) lastResponseLike = parsed;
    var nested = parsed.response;
    if (isRecord(nested) && nested.object === "response") lastResponseLike = nested;
    if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
      lastChatChunk = parsed;
      for (var c = 0; c < parsed.choices.length; c++) {
        var rawChoice = parsed.choices[c];
        if (!isRecord(rawChoice)) continue;
        var idx = typeof rawChoice.index === "number" ? rawChoice.index : 0;
        var key = "choice-" + idx;
        var agg = chatAgg[key];
        if (!agg) {
          agg = { content: "", contentRaw: undefined, reasoning: "", finish: null, tools: {} };
          chatAgg[key] = agg;
        }
        var finish = rawChoice.finish_reason !== undefined ? rawChoice.finish_reason : rawChoice.finishReason;
        if (finish !== undefined && finish !== null) agg.finish = finish;
        var src = isRecord(rawChoice.delta)
          ? rawChoice.delta
          : isRecord(rawChoice.message)
            ? rawChoice.message
            : null;
        if (src) {
          if (typeof src.content === "string") agg.content += src.content;
          else if (src.content !== undefined && src.content !== null) agg.contentRaw = src.content;
          else if (typeof src.text === "string") agg.content += src.text;
          var reasoning = [src.reasoning_content, src.reasoning, src.thinking];
          for (var r = 0; r < reasoning.length; r++) {
            if (typeof reasoning[r] === "string" && reasoning[r]) {
              agg.reasoning += reasoning[r];
              break;
            }
          }
          if (Array.isArray(src.tool_calls)) {
            for (var t = 0; t < src.tool_calls.length; t++) {
              var tc = src.tool_calls[t];
              if (!isRecord(tc)) continue;
              var toolIdx = typeof tc.index === "number" && Number.isFinite(tc.index) ? tc.index : t;
              var slot = agg.tools["tool-" + toolIdx];
              if (!slot) {
                slot = { name: "", arguments: "" };
                agg.tools["tool-" + toolIdx] = slot;
              }
              if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
              if (typeof tc.type === "string" && tc.type) slot.type = tc.type;
              var fn = isRecord(tc.function) ? tc.function : null;
              if (fn) {
                if (typeof fn.name === "string") slot.name += fn.name;
                if (typeof fn.arguments === "string") slot.arguments += fn.arguments;
              }
            }
          }
        } else if (typeof rawChoice.text === "string") {
          agg.content += rawChoice.text;
        } else if (typeof rawChoice.content === "string") {
          agg.content += rawChoice.content;
        }
      }
    }
  }
  if (completed !== undefined || lastResponseLike !== undefined) {
    return completed !== undefined ? completed : lastResponseLike;
  }
  if (lastChatChunk) {
    var aggKeys = Object.keys(chatAgg).sort();
    var choices = [];
    for (var g = 0; g < aggKeys.length; g++) {
      var entry = chatAgg[aggKeys[g]];
      var content = entry.content;
      if (content === "" && entry.contentRaw !== undefined) content = entry.contentRaw;
      if (content === "" && entry.reasoning) content = entry.reasoning;
      var message = { role: "assistant", content: content };
      if (entry.reasoning) message.reasoning_content = entry.reasoning;
      var toolKeys = Object.keys(entry.tools).sort();
      if (toolKeys.length > 0) {
        var calls = [];
        for (var q = 0; q < toolKeys.length; q++) {
          var slotOut = entry.tools[toolKeys[q]];
          calls.push({
            id: slotOut.id,
            type: slotOut.type || "function",
            function: { name: slotOut.name, arguments: slotOut.arguments },
          });
        }
        message.tool_calls = calls;
      }
      choices.push({ index: g, message: message, finish_reason: entry.finish });
    }
    return {
      id: lastChatChunk.id,
      object: "chat.completion",
      model: lastChatChunk.model,
      choices: choices,
      usage: lastChatChunk.usage,
    };
  }
  return undefined;
}

// When the serialized body exceeds maxBytes, the display value keeps only a
// preview, but the full redacted text is returned alongside so copy buttons
// (via requestFull/responseFull) can copy the complete body. Callers pass an
// already-redacted body, so `text` (and therefore `full`) never holds secrets.
function safeCloneBody(body, maxBytes) {
  var text;
  try {
    text = typeof body === "string" ? body : JSON.stringify(body);
  } catch (err) {
    text = String(body);
  }
  var bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { value: body, truncated: false };
  return {
    value: { _truncated: true, _originalBytes: bytes, preview: text.slice(0, PREVIEW_CHARS) },
    truncated: true,
    full: text,
  };
}

function publicUrl(urlStr) {
  if (!urlStr) return undefined;
  try {
    var u = new URL(String(urlStr));
    u.search = "";
    u.hash = "";
    u.username = "";
    u.password = "";
    return u.toString();
  } catch (err) {
    return String(urlStr);
  }
}


function normalizeChannel(raw) {
  if (raw === "official" || raw === "custom-host" || raw === "hop") return raw;
  return "hop";
}

function makeId(raw) {
  if (typeof raw === "string" && /^[A-Za-z0-9._-]{8,80}$/.test(raw)) return raw;
  return crypto.randomUUID();
}

function safeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id) ? id : null;
}

function readRows(file) {
  var text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return [];
  }
  var rows = [];
  var seenIds = Object.create(null);
  var lines = text.split(/\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    try {
      var row = JSON.parse(line);
      // Dedupe by id (keep first): a maintenance repair pass may re-append a
      // row that raced a rewrite, and readers must never double-count it.
      if (isRecord(row) && typeof row.id === "string" && !seenIds[row.id]) {
        seenIds[row.id] = true;
        rows.push(row);
      }
    } catch (err) {
      /* skip bad lines */
    }
  }
  return rows;
}

function writeRows(file, rows, options) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  var opts = options || {};
  // Events use a single-line append; request rewrites keep the tmp+rename
  // discipline so a crash can never leave a truncated JSONL behind.
  if (opts.append === true) {
    var appended = "";
    for (var j = 0; j < rows.length; j++) {
      appended += JSON.stringify(rows[j]) + "\n";
    }
    fs.appendFileSync(file, appended, "utf8");
    return;
  }
  var body = "";
  for (var i = 0; i < rows.length; i++) {
    body += JSON.stringify(rows[i]) + "\n";
  }
  var tmp = file + ".tmp";
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
}

// ---- Aggregate caches (opencode-api: TTL-capped stats/facets). ----

var statsCache = null;
var facetsCache = null;
var usageCache = null;

function cachedResult(cache, nowMs) {
  if (cache && nowMs - cache.at < CACHE_TTL_MS) return cache.value;
  return undefined;
}

function invalidateAggregates() {
  statsCache = null;
  facetsCache = null;
  usageCache = null;
}

function setStatsCache(value) {
  statsCache = { value: value, at: Date.now() };
  return value;
}

function setFacetsCache(value) {
  facetsCache = { value: value, at: Date.now() };
  return value;
}

// ---- Cross-process safety (UI server + host append + prune side by side).
//
// Writers never take the prune lock: rows are appended with O_APPEND
// (fs.appendFileSync), which never truncates a concurrent writer's bytes.
// Only maintenance (prune/strip) takes the lock, via an O_EXCL lockfile, so
// two pruners can never interleave read-modify-write cycles. The lock is
// stale-checked by mtime: a crashed holder cannot wedge pruning forever.

function pruneLockFile() {
  return path.join(sandDataDir(), PRUNE_LOCK_NAME);
}

function sleepMsSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (err) {
    /* sleep is best-effort */
  }
}

function acquirePruneLock(waitMs) {
  var file = pruneLockFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    /* fall through to the create attempt */
  }
  var budget = typeof waitMs === "number" ? waitMs : PRUNE_LOCK_WAIT_MS;
  var deadline = Date.now() + budget;
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid) + "\n", { flag: "wx" });
      return true;
    } catch (err) {
      var stat = null;
      try {
        stat = fs.statSync(file);
      } catch (statErr) {
        continue; // lock vanished between attempts; retry immediately
      }
      if (stat !== null && Date.now() - stat.mtimeMs > PRUNE_LOCK_STALE_MS) {
        try {
          fs.unlinkSync(file);
        } catch (unlinkErr) {
          /* someone else is racing us; fall through to wait */
        }
        continue;
      }
      if (Date.now() >= deadline) return false;
      sleepMsSync(50);
    }
  }
}

function releasePruneLock() {
  try {
    fs.unlinkSync(pruneLockFile());
  } catch (err) {
    /* already gone */
  }
}

function rowIdSet(rows) {
  var ids = Object.create(null);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i] && typeof rows[i].id === "string") ids[rows[i].id] = true;
  }
  return ids;
}

function sortRowsOldestFirst(rows) {
  rows.sort(function (a, b) {
    var left = typeof a.startedAt === "string" ? a.startedAt : "";
    var right = typeof b.startedAt === "string" ? b.startedAt : "";
    if (left === right) return 0;
    return left < right ? 1 : -1;
  });
  rows.reverse();
  return rows;
}

// Merge rows another process appended after `seenRows` was read. Writers
// append lock-free, so the tail can grow between our last read and the
// rewrite: merging narrows that loss window, and repairAppends closes it.
function mergeRows(kept, seenRows, freshRows) {
  var seen = rowIdSet(seenRows);
  var have = rowIdSet(kept);
  for (var i = 0; i < freshRows.length; i++) {
    var row = freshRows[i];
    if (row && typeof row.id === "string" && !seen[row.id] && !have[row.id]) {
      kept.push(row);
      have[row.id] = true;
    }
  }
  return kept;
}

// Re-append rows that landed between our last read and the rewrite. Safe to
// run under the prune lock: writers use O_APPEND, so our repair append and
// their row append both survive (readRows dedupes by id on the next read).
// Callers must pass only rows that were never in the pre-prune read:
// intentionally pruned (expired) rows must never be rescued.
function unseenRows(seenRows, freshRows) {
  var seen = rowIdSet(seenRows);
  var out = [];
  for (var i = 0; i < freshRows.length; i++) {
    var row = freshRows[i];
    if (row && typeof row.id === "string" && !seen[row.id]) out.push(row);
  }
  return out;
}
function repairAppends(file, freshRows) {
  var after = readRows(file);
  var have = rowIdSet(after);
  var missing = [];
  for (var i = 0; i < freshRows.length; i++) {
    var row = freshRows[i];
    if (row && typeof row.id === "string" && !have[row.id]) missing.push(row);
  }
  if (missing.length > 0) writeRows(file, missing, { append: true });
  return missing;
}

function yieldToLoop() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function pruneRows(rows, settings) {
  // Retention is date-based only (logRetentionDays). maxRecords is accepted
  // for read-compat but never enforced (aligned with opencode-api, where
  // retentionDays is the only retention knob).
  var cutoff = cutoffForRetention(settings.logRetentionDays);
  var kept = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (typeof row.startedAt === "string" && row.startedAt >= cutoff) kept.push(row);
  }
  kept.sort(function (a, b) {
    var left = typeof a.startedAt === "string" ? a.startedAt : "";
    var right = typeof b.startedAt === "string" ? b.startedAt : "";
    if (left === right) return 0;
    return left < right ? 1 : -1;
  });
  kept.reverse();
  return kept;
}

function unlinkOrphans(dir, kept, knownIds, nowMs) {
  var ids = rowIdSet(kept);
  var known = knownIds || ids;
  var now = typeof nowMs === "number" ? nowMs : Date.now();
  var files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    return;
  }
  for (var f = 0; f < files.length; f++) {
    var name = files[f];
    if (!name.endsWith(".json")) continue;
    var id = name.slice(0, -5);
    if (ids[id]) continue;
    if (!known[id]) {
      // No row with this id was in the log file: it may be mid-write from
      // another process ("body first, row second"). Only reap it once it is
      // older than the grace window.
      var stat = null;
      try {
        stat = fs.statSync(path.join(dir, name));
      } catch (statErr) {
        continue;
      }
      if (stat === null || now - stat.mtimeMs < ORPHAN_GRACE_MS) continue;
    }
    // A row with this id existed and was pruned away: no live writer will
    // ever append that id again, so the body can go immediately.
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch (err) {
      /* ignore */
    }
  }
}

function pruneNow(settings) {
  if (!acquirePruneLock()) return;
  try {
    var paths = logPaths();
    var seen = readRows(paths.requestLog);
    var kept = pruneRows(seen, settings);
    var fresh = readRows(paths.requestLog);
    mergeRows(kept, seen, fresh);
    sortRowsOldestFirst(kept);
    writeRows(paths.requestLog, kept);
    var rescued = repairAppends(paths.requestLog, unseenRows(seen, fresh));
    for (var i = 0; i < rescued.length; i++) kept.push(rescued[i]);
    unlinkOrphans(paths.bodiesDir, kept, rowIdSet(fresh));
  } finally {
    releasePruneLock();
  }
}

function resolveResponse(input) {
  if (input.responseBody !== undefined) return input.responseBody;
  if (typeof input.responseRaw !== "string") return undefined;
  // An empty upstream payload is "no body", not a blank body: callers use
  // hasResponse to decide whether anything is readable.
  if (!input.responseRaw.trim()) return undefined;
  var text = input.responseRaw;
  if (text.indexOf("data:") !== -1) {
    var rebuilt = extractResponseFromSse(text);
    if (rebuilt !== undefined) return rebuilt;
  }
  var parsed = tryParseJson(text);
  return parsed !== undefined ? parsed : text;
}

function resolveError(input, responseValue) {
  if (typeof input.error === "string" && input.error.trim()) {
    return input.error.trim().slice(0, ERROR_CHARS);
  }
  var fromBody = extractBodyError(responseValue);
  if (fromBody) return fromBody;
  if (typeof input.responseRaw === "string") {
    var fromSse = extractSseError(input.responseRaw);
    if (fromSse) return fromSse;
  }
  return undefined;
}

function resolveUsage(input, responseValue) {
  if (isRecord(input.usage)) {
    return extractUsage({ usage: input.usage }) || extractUsage(input);
  }
  var fromJson = extractUsage(responseValue);
  if (fromJson) return fromJson;
  if (typeof input.responseRaw === "string") return extractUsageFromSse(input.responseRaw);
  return undefined;
}

function recordHopInner(input) {
  var settings = loadSettings();
  if (!settings.loggingEnabled) return;
  var src = isRecord(input) ? input : {};
  var paths = logPaths();
  var secrets = secretValues();
  var startedAt = typeof src.startedAt === "string" && src.startedAt ? src.startedAt : new Date().toISOString();
  var completedAt = typeof src.completedAt === "string" && src.completedAt ? src.completedAt : new Date().toISOString();
  var latencyMs = Number.isFinite(Number(src.latencyMs)) ? Math.max(0, Math.round(Number(src.latencyMs))) : undefined;
  var firstTokenMs = Number.isFinite(Number(src.firstTokenMs))
    ? Math.max(0, Math.round(Number(src.firstTokenMs)))
    : undefined;
  var status = Number.isFinite(Number(src.status)) ? Math.round(Number(src.status)) : 0;
  var responseValue = resolveResponse(src);
  var error = resolveError(src, responseValue);
  if (error) error = redactString(error, secrets).slice(0, ERROR_CHARS);
  var ok = !(status >= 400 || Boolean(error));
  var usage = resolveUsage(src, responseValue);
  var id = makeId(src.id);
  var keepBodies = settings.logBodies || (settings.logBodiesOnError && !ok);
  var hasRequest = false;
  var hasResponse = false;
  var requestTruncated = false;
  var responseTruncated = false;

  if (keepBodies) {
    var bodyFile = { };
    if (src.requestBody !== undefined) {
      var reqCloned = safeCloneBody(redact(src.requestBody, secrets), settings.maxBodyCaptureBytes);
      bodyFile.request = reqCloned.value;
      requestTruncated = reqCloned.truncated;
      // Keep the full redacted text for copy buttons; display still uses the preview.
      if (reqCloned.truncated) bodyFile.requestFull = reqCloned.full;
      hasRequest = true;
    }
    if (responseValue !== undefined) {
      var resCloned = safeCloneBody(redact(responseValue, secrets), settings.maxBodyCaptureBytes);
      bodyFile.response = resCloned.value;
      responseTruncated = resCloned.truncated;
      // Keep the full redacted text for copy buttons; display still uses the preview.
      if (resCloned.truncated) bodyFile.responseFull = resCloned.full;
      hasResponse = true;
    }
  // bodyBytes is precomputed here so stats can SUM metadata instead of
  // re-statting every body file on each read (opencode-api discipline).
  var bodyBytes = 0;
  if (hasRequest || hasResponse) {
    fs.mkdirSync(paths.bodiesDir, { recursive: true });
    var bodyText = JSON.stringify(bodyFile);
    bodyBytes = Buffer.byteLength(bodyText, "utf8");
    fs.writeFileSync(path.join(paths.bodiesDir, id + ".json"), bodyText, "utf8");
  }
  }

  var channel = normalizeChannel(src.channel);
  var inbound = typeof src.inboundEndpoint === "string" && src.inboundEndpoint
    ? src.inboundEndpoint
    : (channel === "hop" ? "/v1/chat/completions" : "host-stream");
  var row = {
    id: id,
    startedAt: startedAt,
    completedAt: completedAt,
    ok: ok,
    status: status,
    channel: channel,
    inboundEndpoint: inbound,
    stream: src.stream === true,
    hasRequest: hasRequest,
    hasResponse: hasResponse,
  };
  if (latencyMs !== undefined) row.latencyMs = latencyMs;
  if (typeof src.model === "string" && src.model) row.model = src.model;
  if (typeof src.providerId === "string" && src.providerId) row.providerId = src.providerId;
  if (typeof src.providerName === "string" && src.providerName) row.providerName = src.providerName;
  var upstream = publicUrl(src.upstreamEndpoint);
  if (upstream) row.upstreamEndpoint = upstream;
  if (error) row.error = error;
  if (requestTruncated) row.requestTruncated = true;
  if (responseTruncated) row.responseTruncated = true;
  if (bodyBytes > 0) row.bodyBytes = bodyBytes;
  if (usage) {
    if (usage.promptTokens !== undefined) row.promptTokens = usage.promptTokens;
    if (usage.completionTokens !== undefined) row.completionTokens = usage.completionTokens;
    if (usage.totalTokens !== undefined) row.totalTokens = usage.totalTokens;
    if (usage.cachedTokens !== undefined) row.cachedTokens = usage.cachedTokens;
    if (usage.reasoningTokens !== undefined) row.reasoningTokens = usage.reasoningTokens;
    if (usage.textTokens !== undefined) row.textTokens = usage.textTokens;
    if (usage.imageTokens !== undefined) row.imageTokens = usage.imageTokens;
    if (usage.audioTokens !== undefined) row.audioTokens = usage.audioTokens;
  }
  if (firstTokenMs !== undefined) row.firstTokenMs = firstTokenMs;
  // Upstream attempt chain (hop-handler retry loop): per-attempt status /
  // error / latency. Sanitized and capped so a pathological retry storm can
  // never bloat the JSONL row.
  var attempts = sanitizeAttempts(src.attempts);
  if (attempts) {
    row.attempts = attempts;
    row.attemptCount = attempts.length;
  } else if (Number.isFinite(Number(src.attemptCount))) {
    row.attemptCount = Math.max(1, Math.round(Number(src.attemptCount)));
  }
  // Source metadata collected from the inbound request (best-effort: the
  // OpenAI-compatible hop protocol carries no bot/chat identity, so these
  // are UA/header/body clues, not chat identifiers).
  var clientName = cleanText(src.clientName, 120);
  if (clientName) row.clientName = clientName;
  var clientVersion = cleanText(src.clientVersion, 40);
  if (clientVersion) row.clientVersion = clientVersion;
  var userAgent = cleanText(src.userAgent, 512);
  if (userAgent) row.userAgent = userAgent;
  var conversationId = cleanText(src.conversationId, 128);
  if (conversationId) row.conversationId = conversationId;
  var requestId = cleanText(src.requestId, 128);
  if (requestId) row.requestId = requestId;
  var origin = cleanText(src.origin, 120);
  if (origin) row.origin = origin;

  // Append-only, lock-free: O_APPEND never truncates a concurrent writer's
  // bytes, so the UI server and the host process record side by side with
  // no read-modify-write cycle. Retention and orphan cleanup are owned by
  // the UI server's scheduled cleanup (pruneNowAsync); the write path never
  // prunes, so a body file can never be reaped between "body written" and
  // "row appended".
  fs.mkdirSync(path.dirname(paths.requestLog), { recursive: true });
  fs.appendFileSync(paths.requestLog, JSON.stringify(row) + "\n", "utf8");
  invalidateAggregates();
}

function recordHop(input) {
  try {
    recordHopInner(input);
  } catch (err) {
    /* never throw into the chat path */
  }
}

function cleanText(value, max) {
  if (typeof value !== "string") return undefined;
  var text = value.trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function sanitizeAttempts(value) {
  if (!Array.isArray(value)) return undefined;
  var out = [];
  for (var i = 0; i < value.length && out.length < 10; i++) {
    var attempt = value[i];
    if (!isRecord(attempt)) continue;
    var entry = {};
    if (Number.isFinite(Number(attempt.attempt))) {
      entry.attempt = Math.max(1, Math.round(Number(attempt.attempt)));
    }
    if (Number.isFinite(Number(attempt.status))) entry.status = Math.round(Number(attempt.status));
    if (Number.isFinite(Number(attempt.latencyMs))) {
      entry.latencyMs = Math.max(0, Math.round(Number(attempt.latencyMs)));
    }
    var errText = cleanText(attempt.error, 500);
    if (errText) entry.error = errText;
    var decision = cleanText(attempt.decision, 20);
    if (decision) entry.decision = decision;
    out.push(entry);
  }
  return out.length ? out : undefined;
}

function matchesQuery(row, query) {
  if (query.ok === true && row.ok !== true) return false;
  if (query.ok === false && row.ok !== false) return false;
  if (query.channel === "official") {
    if (row.channel !== "official") return false;
  } else if (query.channel === "custom") {
    if (row.channel === "official") return false;
  } else if (typeof query.channel === "string" && query.channel) {
    if (row.channel !== query.channel) return false;
  }
  if (typeof query.model === "string" && query.model) {
    if (row.model !== query.model) return false;
  }
  if (typeof query.from === "string" && query.from) {
    if (typeof row.startedAt !== "string" || row.startedAt < query.from) return false;
  }
  if (typeof query.to === "string" && query.to) {
    if (typeof row.startedAt !== "string" || row.startedAt > query.to) return false;
  }
  if (typeof query.q === "string" && query.q.trim()) {
    var needle = query.q.trim().toLowerCase();
    var hay = [
      row.id,
      row.model,
      row.error,
      row.providerId,
      row.providerName,
      row.channel,
      row.inboundEndpoint,
      row.upstreamEndpoint,
      row.clientName,
      row.userAgent,
      row.conversationId,
      row.requestId,
    ]
      .filter(function (part) { return typeof part === "string"; })
      .join(" ")
      .toLowerCase();
    if (hay.indexOf(needle) === -1) return false;
  }
  return true;
}

function listRequests(query) {
  try {
    var q = isRecord(query) ? query : {};
    var page = Number(q.page);
    if (!Number.isInteger(page) || page < 1) page = 1;
    var pageSize = Number(q.pageSize);
    if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = 50;
    if (pageSize > 100) pageSize = 100;
    var rows = readRows(logPaths().requestLog);
    var matched = [];
    for (var i = 0; i < rows.length; i++) {
      if (matchesQuery(rows[i], q)) matched.push(rows[i]);
    }
    matched.sort(function (a, b) {
      var left = typeof a.startedAt === "string" ? a.startedAt : "";
      var right = typeof b.startedAt === "string" ? b.startedAt : "";
      if (left === right) return 0;
      return left < right ? 1 : -1;
    });
    var total = matched.length;
    var start = (page - 1) * pageSize;
    return {
      items: matched.slice(start, start + pageSize),
      total: total,
      page: page,
      pageSize: pageSize,
      approximate: false,
    };
  } catch (err) {
    return { items: [], total: 0, page: 1, pageSize: 50, approximate: false };
  }
}

function readBodyFile(dir, id) {
  try {
    var parsed = JSON.parse(fs.readFileSync(path.join(dir, id + ".json"), "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

function getRequest(id) {
  try {
    var safe = safeId(id);
    if (!safe) return null;
    var paths = logPaths();
    var rows = readRows(paths.requestLog);
    var row = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === safe) {
        row = rows[i];
        break;
      }
    }
    if (!row) return null;
    var bodies = readBodyFile(paths.bodiesDir, safe);
    var detail = Object.assign({}, row);
    var attachedRequest = false;
    var attachedResponse = false;
    if (Object.prototype.hasOwnProperty.call(bodies, "request")) {
      detail.request = bodies.request;
      attachedRequest = true;
    }
    if (Object.prototype.hasOwnProperty.call(bodies, "response")) {
      detail.response = bodies.response;
      attachedResponse = true;
    }
    if (Object.prototype.hasOwnProperty.call(bodies, "requestFull")) detail.requestFull = bodies.requestFull;
    if (Object.prototype.hasOwnProperty.call(bodies, "responseFull")) detail.responseFull = bodies.responseFull;
    // The row claims a body exists but the sidecar file is gone (pruned by
    // hand, raced with cleanup, ...): say so explicitly instead of serving
    // a "blank" detail the UI cannot distinguish from an empty payload.
    if ((row.hasRequest && !attachedRequest) || (row.hasResponse && !attachedResponse)) {
      detail.bodyMissing = true;
    }
    return detail;
  } catch (err) {
    return null;
  }
}

function clearRequests() {
  var paths = logPaths();
  // Best-effort maintenance lock so a concurrent prune cannot interleave.
  var locked = acquirePruneLock(PRUNE_LOCK_WAIT_ASYNC_MS);
  try {
    try {
      writeRows(paths.requestLog, []);
    } catch (err) {
      /* ignore */
    }
  } finally {
    if (locked) releasePruneLock();
  }
  var files;
  try {
    files = fs.readdirSync(paths.bodiesDir);
  } catch (err) {
    return;
  }
  for (var i = 0; i < files.length; i++) {
    try {
      fs.unlinkSync(path.join(paths.bodiesDir, files[i]));
    } catch (err) {
      /* ignore */
    }
  }
  invalidateAggregates();
}

// ---- Events (opencode-api: type/severity/message/metadata + requestId). ----

var EVENT_SEVERITIES = { INFO: true, WARN: true, ERROR: true };

function appendEvent(input) {
  try {
    var src = isRecord(input) ? input : {};
    var severity = typeof src.severity === "string" && EVENT_SEVERITIES[src.severity.toUpperCase()]
      ? src.severity.toUpperCase()
      : "INFO";
    var event = {
      id: makeId(src.id),
      at: typeof src.at === "string" && src.at ? src.at : new Date().toISOString(),
      type: typeof src.type === "string" && src.type ? src.type.slice(0, 120) : "note",
      severity: severity,
      message: typeof src.message === "string" ? src.message.slice(0, 2000) : "",
    };
    if (typeof src.requestId === "string" && src.requestId) event.requestId = src.requestId.slice(0, 80);
    if (isRecord(src.metadata)) {
      try {
        var metaText = JSON.stringify(src.metadata);
        if (Buffer.byteLength(metaText, "utf8") <= 8192) event.metadata = src.metadata;
      } catch (err) {
        /* drop oversized/unserializable metadata */
      }
    }
    var paths = logPaths();
    fs.mkdirSync(path.dirname(paths.eventsLog), { recursive: true });
    fs.appendFileSync(paths.eventsLog, JSON.stringify(event) + "\n", "utf8");
    trimEventsFile(paths.eventsLog);
    return event;
  } catch (err) {
    return null;
  }
}

// Cap the events file by bytes and rows so a chatty loop can never grow it
// without bound. Oldest lines are dropped first; the file stays newest-last.
function trimEventsFile(file) {
  var stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return;
  }
  if (stat.size <= MAX_EVENT_BYTES) return;
  try {
    var lines = fs.readFileSync(file, "utf8").split(/\n/);
    var kept = [];
    for (var i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      kept.push(lines[i]);
      if (kept.length >= MAX_EVENT_KEPT) break;
    }
    kept.reverse();
    fs.writeFileSync(file, kept.join("\n") + "\n", "utf8");
  } catch (err) {
    /* best-effort */
  }
}

function queryEvents(query) {
  try {
    var q = isRecord(query) ? query : {};
    var limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1) limit = 100;
    if (limit > 500) limit = 500;
    var rows = readRows(logPaths().eventsLog);
    var matched = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (typeof q.severity === "string" && q.severity) {
        if (String(row.severity || "").toUpperCase() !== q.severity.toUpperCase()) continue;
      }
      if (typeof q.type === "string" && q.type) {
        if (row.type !== q.type) continue;
      }
      if (typeof q.requestId === "string" && q.requestId) {
        if (row.requestId !== q.requestId) continue;
      }
      matched.push(row);
    }
    matched.sort(function (a, b) {
      var left = typeof a.at === "string" ? a.at : "";
      var right = typeof b.at === "string" ? b.at : "";
      if (left === right) return 0;
      return left < right ? 1 : -1;
    });
    return { items: matched.slice(0, limit), total: matched.length };
  } catch (err) {
    return { items: [], total: 0 };
  }
}

// ---- Async batched cleanup (opencode-api log-cleanup.ts discipline). ----
//
// Every batch is bounded (PRUNE_BATCH rows) and yields to the event loop via
// setImmediate between batches, so a large backlog can never hold the loop
// hostage. ISO-8601 timestamps compare lexicographically, so the cutoff
// check is a plain string compare with no Date parsing per row.

function retentionCutoffIso(settings) {
  var days = settings && settings.logRetentionDays !== undefined
    ? settings.logRetentionDays
    : DEFAULTS.logRetentionDays;
  return cutoffForRetention(days);
}

function pruneNowAsync(settings, onBatch) {
  var paths = logPaths();
  // Serialize pruners across processes. Writers append lock-free (O_APPEND),
  // so holding this lock never blocks chat; it only stops two maintenance
  // passes from interleaving read-modify-write cycles.
  if (!acquirePruneLock(PRUNE_LOCK_WAIT_ASYNC_MS)) {
    return Promise.resolve({
      skipped: true,
      removedByRetention: 0,
      removedByCap: 0,
      kept: readRows(paths.requestLog).length,
    });
  }
  var cutoff = retentionCutoffIso(settings);
  // No count cap: retention is date-based only. settings.maxRecords, when
  // present, is ignored (read-compat).
  var rows = readRows(paths.requestLog);
  var removedByRetention = 0;
  var kept = [];
  var index = 0;
  function finish() {
    try {
      // removedByCap stays in the result shape for backward compat and is
      // always 0 now that no count cap is enforced.
      var removedByCap = 0;
      var fresh = readRows(paths.requestLog);
      mergeRows(kept, rows, fresh);
      sortRowsOldestFirst(kept);
      writeRows(paths.requestLog, kept);
      var rescued = repairAppends(paths.requestLog, unseenRows(rows, fresh));
      for (var i = 0; i < rescued.length; i++) kept.push(rescued[i]);
      unlinkOrphans(paths.bodiesDir, kept, rowIdSet(fresh));
      invalidateAggregates();
      return {
        removedByRetention: removedByRetention,
        removedByCap: removedByCap,
        kept: kept.length,
      };
    } finally {
      releasePruneLock();
    }
  }
  function step() {
    var end = Math.min(index + PRUNE_BATCH, rows.length);
    for (; index < end; index++) {
      var row = rows[index];
      if (typeof row.startedAt === "string" && row.startedAt >= cutoff) {
        kept.push(row);
      } else {
        removedByRetention++;
      }
    }
    if (typeof onBatch === "function") {
      try {
        onBatch({ processed: index, kept: kept.length, removedByRetention: removedByRetention });
      } catch (err) {
        /* progress callback must not break cleanup */
      }
    }
    if (index < rows.length) return yieldToLoop().then(step);
    return finish();
  }
  // Always async: callers (and the UI scheduler) rely on a Promise, even
  // when there is nothing to prune.
  return Promise.resolve()
    .then(step)
    .then(
      function (result) {
        return result;
      },
      function (err) {
        releasePruneLock();
        throw err;
      },
    );
}

function cleanupNowAsync(settings, onBatch) {
  var active = settings || loadSettings();
  return pruneNowAsync(active, onBatch).then(function (result) {
    try {
      appendEvent({
        type: "logs.cleanup",
        severity: "INFO",
        message: "Cleaned request logs: " +
          String(result.removedByRetention) + " expired, " +
          String(result.removedByCap) + " over cap (cap retired; retention is date-based), " +
          String(result.kept) + " kept.",
        metadata: result,
      });
    } catch (err) {
      /* event write is best-effort */
    }
    return result;
  });
}

// ---- Stats + facets (opencode-api lightweight-count.ts discipline). ----
//
// cappedCount bounds every scan (MAX_TOTAL_COUNT rows); results carry
// approximate:true once the cap is hit, and both endpoints share a 60s TTL
// cache (CACHE_TTL_MS) so repeated UI polls never rescan the file.

function numField(row, key) {
  return typeof row[key] === "number" && Number.isFinite(row[key]) ? row[key] : 0;
}

function statsNow() {
  var cached = cachedResult(statsCache, Date.now());
  if (cached !== undefined) return cached;
  var paths = logPaths();
  var rows = readRows(paths.requestLog);
  var capped = rows.length > MAX_TOTAL_COUNT;
  var scanned = capped ? rows.slice(rows.length - MAX_TOTAL_COUNT) : rows;
  var errors = 0;
  var promptTokens = 0;
  var completionTokens = 0;
  var totalTokens = 0;
  var cachedTokens = 0;
  var reasoningTokens = 0;
  var bodyBytes = 0;
  var ok = 0;
  for (var i = 0; i < scanned.length; i++) {
    var row = scanned[i];
    if (row.ok === true) ok++;
    else errors++;
    promptTokens += numField(row, "promptTokens");
    completionTokens += numField(row, "completionTokens");
    totalTokens += numField(row, "totalTokens");
    cachedTokens += numField(row, "cachedTokens");
    reasoningTokens += numField(row, "reasoningTokens");
    bodyBytes += numField(row, "bodyBytes");
  }
  var diskBytes = 0;
  try {
    diskBytes += fs.statSync(paths.requestLog).size;
  } catch (err) {
    /* file may not exist yet */
  }
  // Bodies dir: stat at most STATS_DISK_SCAN_CAP files, then extrapolate.
  var bodyFiles = 0;
  var bodyDiskBytes = 0;
  var bodyDirCapped = false;
  try {
    var names = fs.readdirSync(paths.bodiesDir);
    bodyFiles = names.length;
    var scanCount = Math.min(names.length, STATS_DISK_SCAN_CAP);
    bodyDirCapped = names.length > STATS_DISK_SCAN_CAP;
    for (var f = 0; f < scanCount; f++) {
      try {
        bodyDiskBytes += fs.statSync(path.join(paths.bodiesDir, names[f])).size;
      } catch (err) {
        /* race with prune */
      }
    }
    if (bodyDirCapped && scanCount > 0) {
      bodyDiskBytes = Math.round((bodyDiskBytes / scanCount) * names.length);
    }
  } catch (err) {
    /* no bodies dir yet */
  }
  diskBytes += bodyDiskBytes;
  var value = {
    records: rows.length,
    scanned: scanned.length,
    approximate: capped,
    ok: ok,
    errors: errors,
    promptTokens: promptTokens,
    completionTokens: completionTokens,
    totalTokens: totalTokens,
    cachedTokens: cachedTokens,
    reasoningTokens: reasoningTokens,
    bodyBytes: bodyBytes,
    bodyFiles: bodyFiles,
    bodyDiskBytes: bodyDiskBytes,
    bodiesApproximate: bodyDirCapped,
    diskBytes: diskBytes,
  };
  return setStatsCache(value);
}

function facetsNow() {
  var cached = cachedResult(facetsCache, Date.now());
  if (cached !== undefined) return cached;
  var rows = readRows(logPaths().requestLog);
  var sample = rows.length > FACETS_SAMPLE_LIMIT
    ? rows.slice(rows.length - FACETS_SAMPLE_LIMIT)
    : rows;
  function top(key) {
    var counts = Object.create(null);
    for (var i = 0; i < sample.length; i++) {
      var v = sample[i][key];
      if (typeof v !== "string" || !v) continue;
      counts[v] = (counts[v] || 0) + 1;
    }
    var names = Object.keys(counts);
    names.sort(function (a, b) { return counts[b] - counts[a]; });
    var capped = names.length > FACETS_MAX_OPTIONS;
    if (capped) names = names.slice(0, FACETS_MAX_OPTIONS);
    return {
      values: names.map(function (name) { return { value: name, count: counts[name] }; }),
      approximate: capped || rows.length > FACETS_SAMPLE_LIMIT,
    };
  }
  function statusFacet() {
    var counts = Object.create(null);
    for (var i = 0; i < sample.length; i++) {
      var key = typeof sample[i].status === "number" ? String(sample[i].status) : "0";
      counts[key] = (counts[key] || 0) + 1;
    }
    var names = Object.keys(counts);
    names.sort(function (a, b) { return counts[b] - counts[a]; });
    var capped = names.length > FACETS_MAX_OPTIONS;
    if (capped) names = names.slice(0, FACETS_MAX_OPTIONS);
    return {
      values: names.map(function (name) { return { value: name, count: counts[name] }; }),
      approximate: capped || rows.length > FACETS_SAMPLE_LIMIT,
    };
  }
  var value = {
    sampled: sample.length,
    total: rows.length,
    model: top("model"),
    provider: top("providerId"),
    channel: top("channel"),
    status: statusFacet(),
  };
  return setFacetsCache(value);
}

// ---- Usage aggregation (opencode-api usage-stats discipline). ----
//
// GET /api/logs/usage groups the newest USAGE_SCAN_LIMIT rows by day, model
// and provider. The scan is capped, group lists are truncated, every result
// carries approximate:true once a cap is hit, and identical queries share a
// 60s TTL cache entry — the JSONL file is never scanned unboundedly.
var USAGE_SCAN_LIMIT = 5000;
var USAGE_BUCKET_LIMIT = 50;

function newUsageBucket() {
  return {
    requests: 0,
    ok: 0,
    fail: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    latencySum: 0,
    latencyCount: 0,
    firstTokenSum: 0,
    firstTokenCount: 0,
  };
}

function addUsageRow(bucket, row) {
  bucket.requests += 1;
  if (row.ok === true) bucket.ok += 1;
  else bucket.fail += 1;
  bucket.promptTokens += numField(row, "promptTokens");
  bucket.completionTokens += numField(row, "completionTokens");
  bucket.totalTokens += numField(row, "totalTokens");
  bucket.cachedTokens += numField(row, "cachedTokens");
  bucket.reasoningTokens += numField(row, "reasoningTokens");
  if (typeof row.latencyMs === "number" && Number.isFinite(row.latencyMs)) {
    bucket.latencySum += row.latencyMs;
    bucket.latencyCount += 1;
  }
  if (typeof row.firstTokenMs === "number" && Number.isFinite(row.firstTokenMs)) {
    bucket.firstTokenSum += row.firstTokenMs;
    bucket.firstTokenCount += 1;
  }
}

function finalizeUsageBucket(key, bucket) {
  return {
    key: key,
    requests: bucket.requests,
    ok: bucket.ok,
    fail: bucket.fail,
    promptTokens: bucket.promptTokens,
    completionTokens: bucket.completionTokens,
    totalTokens: bucket.totalTokens,
    cachedTokens: bucket.cachedTokens,
    reasoningTokens: bucket.reasoningTokens,
    avgLatencyMs: bucket.latencyCount > 0 ? bucket.latencySum / bucket.latencyCount : 0,
    avgFirstTokenMs: bucket.firstTokenCount > 0 ? bucket.firstTokenSum / bucket.firstTokenCount : null,
  };
}

function usageNow(query) {
  var q = isRecord(query) ? query : {};
  var from = typeof q.from === "string" ? q.from : "";
  var to = typeof q.to === "string" ? q.to : "";
  var modelFilter = typeof q.model === "string" ? q.model : "";
  var providerFilter = typeof q.provider === "string" ? q.provider : "";
  var cacheKey = JSON.stringify([from, to, modelFilter, providerFilter]);
  var nowMs = Date.now();
  if (usageCache && nowMs - usageCache.at < CACHE_TTL_MS && usageCache.key === cacheKey) {
    return usageCache.value;
  }
  var rows = readRows(logPaths().requestLog);
  var total = rows.length;
  var filtered = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (from && (typeof row.startedAt !== "string" || row.startedAt < from)) continue;
    if (to && (typeof row.startedAt !== "string" || row.startedAt > to)) continue;
    if (modelFilter && row.model !== modelFilter) continue;
    if (providerFilter) {
      var providerName =
        typeof row.providerId === "string" && row.providerId
          ? row.providerId
          : typeof row.providerName === "string"
            ? row.providerName
            : "";
      if (providerName !== providerFilter) continue;
    }
    filtered.push(row);
  }
  var capped = filtered.length > USAGE_SCAN_LIMIT;
  var scanned = capped ? filtered.slice(filtered.length - USAGE_SCAN_LIMIT) : filtered;
  var byDay = {};
  var byModel = {};
  var byProvider = {};
  for (var s = 0; s < scanned.length; s++) {
    var item = scanned[s];
    var day = typeof item.startedAt === "string" ? item.startedAt.slice(0, 10) : "(unknown)";
    var modelKey = typeof item.model === "string" && item.model ? item.model : "(unknown)";
    var providerKey =
      typeof item.providerId === "string" && item.providerId
        ? item.providerId
        : typeof item.providerName === "string" && item.providerName
          ? item.providerName
          : "(unknown)";
    if (!byDay[day]) byDay[day] = newUsageBucket();
    if (!byModel[modelKey]) byModel[modelKey] = newUsageBucket();
    if (!byProvider[providerKey]) byProvider[providerKey] = newUsageBucket();
    addUsageRow(byDay[day], item);
    addUsageRow(byModel[modelKey], item);
    addUsageRow(byProvider[providerKey], item);
  }
  var truncated = false;
  function finalizeGroups(map, sortDesc) {
    var keys = Object.keys(map);
    if (sortDesc) {
      keys.sort(function (a, b) { return map[b].requests - map[a].requests; });
    } else {
      keys.sort();
    }
    if (keys.length > USAGE_BUCKET_LIMIT) {
      truncated = true;
      keys = keys.slice(0, USAGE_BUCKET_LIMIT);
    }
    return keys.map(function (key) { return finalizeUsageBucket(key, map[key]); });
  }
  var value = {
    approximate: capped || truncated,
    scanned: scanned.length,
    total: total,
    from: from,
    to: to,
    byDay: finalizeGroups(byDay, false),
    byModel: finalizeGroups(byModel, true),
    byProvider: finalizeGroups(byProvider, true),
  };
  usageCache = { key: cacheKey, value: value, at: nowMs };
  return value;
}

// ---- One-shot body stripping (opencode-api stripAllBodies discipline). ----
//
// Deletes captured request/response bodies but keeps every metadata row, so
// history stays browsable while stored payloads are gone. Batched with a
// yield between batches; each batch removes at most PRUNE_BATCH files.

function stripBodiesAsync() {
  var paths = logPaths();
  if (!acquirePruneLock(PRUNE_LOCK_WAIT_ASYNC_MS)) {
    return Promise.resolve({ stripped: 0, skipped: true });
  }
  var names;
  try {
    names = fs.readdirSync(paths.bodiesDir);
  } catch (err) {
    releasePruneLock();
    return Promise.resolve({ stripped: 0 });
  }
  var files = [];
  for (var i = 0; i < names.length; i++) {
    if (names[i].endsWith(".json")) files.push(names[i]);
  }
  var stripped = 0;
  var index = 0;
  function step() {
    var end = Math.min(index + PRUNE_BATCH, files.length);
    for (; index < end; index++) {
      try {
        fs.unlinkSync(path.join(paths.bodiesDir, files[index]));
        stripped++;
      } catch (err) {
        /* race with prune */
      }
    }
    if (index < files.length) return yieldToLoop().then(step);
    try {
      var rows = readRows(paths.requestLog);
      for (var r = 0; r < rows.length; r++) {
        if (rows[r].hasRequest) rows[r].hasRequest = false;
        if (rows[r].hasResponse) rows[r].hasResponse = false;
        if (rows[r].bodyBytes !== undefined) delete rows[r].bodyBytes;
        if (rows[r].requestTruncated !== undefined) delete rows[r].requestTruncated;
        if (rows[r].responseTruncated !== undefined) delete rows[r].responseTruncated;
      }
      writeRows(paths.requestLog, rows);
      invalidateAggregates();
    } finally {
      releasePruneLock();
    }
    try {
      appendEvent({
        type: "logs.strip-bodies",
        severity: "WARN",
        message: "Stripped " + String(stripped) + " captured bodies; metadata kept.",
        metadata: { stripped: stripped },
      });
    } catch (err) {
      /* best-effort */
    }
    return { stripped: stripped };
  }
  return Promise.resolve()
    .then(step)
    .then(
      function (result) {
        return result;
      },
      function (err) {
        releasePruneLock();
        throw err;
      },
    );
}

exports.DEFAULTS = DEFAULTS;
exports.logPaths = logPaths;
exports.cutoffForRetention = cutoffForRetention;
exports.loadSettings = loadSettings;
exports.saveSettings = saveSettings;
exports.recordHop = recordHop;
exports.listRequests = listRequests;
exports.getRequest = getRequest;
exports.clearRequests = clearRequests;
exports.redact = redact;
exports.extractBodyError = extractBodyError;
exports.safeCloneBody = safeCloneBody;
exports.pruneRows = pruneRows;
exports.pruneNow = pruneNow;
exports.pruneNowAsync = pruneNowAsync;
exports.cleanupNowAsync = cleanupNowAsync;
exports.statsNow = statsNow;
exports.facetsNow = facetsNow;
exports.usageNow = usageNow;
exports.extractUsage = extractUsage;
exports.mergeUsage = mergeUsage;
exports.extractResponseFromSse = extractResponseFromSse;
exports.sseChunkHasContent = sseChunkHasContent;
exports.appendEvent = appendEvent;
exports.queryEvents = queryEvents;
exports.stripBodiesAsync = stripBodiesAsync;
exports.invalidateAggregates = invalidateAggregates;
