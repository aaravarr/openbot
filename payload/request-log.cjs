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

function extractUsage(payload) {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
  var usage = payload.usage;
  var promptTokens = num(usage.prompt_tokens) ?? num(usage.input_tokens) ?? num(usage.promptTokens);
  var completionTokens = num(usage.completion_tokens) ?? num(usage.output_tokens) ?? num(usage.completionTokens);
  var totalTokens = num(usage.total_tokens) ?? num(usage.totalTokens);
  if (totalTokens === undefined && promptTokens !== undefined && completionTokens !== undefined) {
    totalTokens = promptTokens + completionTokens;
  }
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  var out = {};
  if (promptTokens !== undefined) out.promptTokens = promptTokens;
  if (completionTokens !== undefined) out.completionTokens = completionTokens;
  if (totalTokens !== undefined) out.totalTokens = totalTokens;
  return out;
}

function extractUsageFromSse(text) {
  if (typeof text !== "string" || text.indexOf("data:") === -1) return undefined;
  var last;
  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || line.indexOf("data:") !== 0) continue;
    var data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    var parsed = tryParseJson(data);
    var usage = extractUsage(parsed);
    if (usage) last = usage;
  }
  return last;
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
  var lines = text.split(/\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    try {
      var row = JSON.parse(line);
      if (isRecord(row) && typeof row.id === "string") rows.push(row);
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

function cachedResult(cache, nowMs) {
  if (cache && nowMs - cache.at < CACHE_TTL_MS) return cache.value;
  return undefined;
}

function invalidateAggregates() {
  statsCache = null;
  facetsCache = null;
}

function setStatsCache(value) {
  statsCache = { value: value, at: Date.now() };
  return value;
}

function setFacetsCache(value) {
  facetsCache = { value: value, at: Date.now() };
  return value;
}

// The sync write path (recordHopInner) must never block chat: a full prune
// runs at most once per WRITE_PRUNE_INTERVAL_MS there. Steady-state pruning
// is owned by the scheduled cleanup (pruneNowAsync / cleanupNowAsync).
var lastWritePruneAt = 0;
var WRITE_PRUNE_INTERVAL_MS = 60 * 1000;

function yieldToLoop() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function pruneRows(rows, settings) {
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
  if (kept.length > settings.maxRecords) kept = kept.slice(0, settings.maxRecords);
  kept.reverse();
  return kept;
}

function unlinkOrphans(dir, kept) {
  var ids = Object.create(null);
  for (var i = 0; i < kept.length; i++) ids[kept[i].id] = true;
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
    if (!ids[id]) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch (err) {
        /* ignore */
      }
    }
  }
}

function pruneNow(settings) {
  var paths = logPaths();
  var kept = pruneRows(readRows(paths.requestLog), settings);
  writeRows(paths.requestLog, kept);
  unlinkOrphans(paths.bodiesDir, kept);
}

function resolveResponse(input) {
  if (input.responseBody !== undefined) return input.responseBody;
  if (typeof input.responseRaw !== "string") return undefined;
  var parsed = tryParseJson(input.responseRaw);
  return parsed !== undefined ? parsed : input.responseRaw;
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
  }

  var rows = readRows(paths.requestLog);
  rows.push(row);
  // Gated sync prune: full retention+cap enforcement runs here at most once
  // per WRITE_PRUNE_INTERVAL_MS (or whenever the cap is exceeded); the
  // scheduled cleanup owns steady-state pruning.
  var nowMs = Date.now();
  if (rows.length > settings.maxRecords || nowMs - lastWritePruneAt > WRITE_PRUNE_INTERVAL_MS) {
    lastWritePruneAt = nowMs;
    var kept = pruneRows(rows, settings);
    writeRows(paths.requestLog, kept);
    unlinkOrphans(paths.bodiesDir, kept);
  } else {
    writeRows(paths.requestLog, rows);
  }
  invalidateAggregates();
}

function recordHop(input) {
  try {
    recordHopInner(input);
  } catch (err) {
    /* never throw into the chat path */
  }
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
    if (Object.prototype.hasOwnProperty.call(bodies, "request")) detail.request = bodies.request;
    if (Object.prototype.hasOwnProperty.call(bodies, "response")) detail.response = bodies.response;
    if (Object.prototype.hasOwnProperty.call(bodies, "requestFull")) detail.requestFull = bodies.requestFull;
    if (Object.prototype.hasOwnProperty.call(bodies, "responseFull")) detail.responseFull = bodies.responseFull;
    return detail;
  } catch (err) {
    return null;
  }
}

function clearRequests() {
  var paths = logPaths();
  try {
    writeRows(paths.requestLog, []);
  } catch (err) {
    /* ignore */
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
  var cutoff = retentionCutoffIso(settings);
  var maxRecords = settings && Number.isInteger(settings.maxRecords) && settings.maxRecords > 0
    ? settings.maxRecords
    : DEFAULTS.maxRecords;
  var rows = readRows(paths.requestLog);
  var removedByRetention = 0;
  var kept = [];
  var index = 0;
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
    kept.sort(function (a, b) {
      var left = typeof a.startedAt === "string" ? a.startedAt : "";
      var right = typeof b.startedAt === "string" ? b.startedAt : "";
      if (left === right) return 0;
      return left < right ? 1 : -1;
    });
    var removedByCap = 0;
    if (kept.length > maxRecords) {
      removedByCap = kept.length - maxRecords;
      kept = kept.slice(0, maxRecords);
    }
    kept.reverse();
    writeRows(paths.requestLog, kept);
    unlinkOrphans(paths.bodiesDir, kept);
    invalidateAggregates();
    return {
      removedByRetention: removedByRetention,
      removedByCap: removedByCap,
      kept: kept.length,
    };
  }
  // Always async: callers (and the UI scheduler) rely on a Promise, even
  // when there is nothing to prune.
  return Promise.resolve().then(step);
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
          String(result.removedByCap) + " over cap, " +
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
  var bodyBytes = 0;
  var ok = 0;
  for (var i = 0; i < scanned.length; i++) {
    var row = scanned[i];
    if (row.ok === true) ok++;
    else errors++;
    promptTokens += numField(row, "promptTokens");
    completionTokens += numField(row, "completionTokens");
    totalTokens += numField(row, "totalTokens");
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

// ---- One-shot body stripping (opencode-api stripAllBodies discipline). ----
//
// Deletes captured request/response bodies but keeps every metadata row, so
// history stays browsable while stored payloads are gone. Batched with a
// yield between batches; each batch removes at most PRUNE_BATCH files.

function stripBodiesAsync() {
  var paths = logPaths();
  var names;
  try {
    names = fs.readdirSync(paths.bodiesDir);
  } catch (err) {
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
  return Promise.resolve().then(step);
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
exports.appendEvent = appendEvent;
exports.queryEvents = queryEvents;
exports.stripBodiesAsync = stripBodiesAsync;
exports.invalidateAggregates = invalidateAggregates;
