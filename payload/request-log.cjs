"use strict";

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

var PREVIEW_CHARS = 8000;
var ERROR_CHARS = 500;
var DEFAULT_SAND_DATA = "/home/box/sand-data";

var DEFAULTS = {
  loggingEnabled: false,
  logBodies: false,
  logBodiesOnError: true,
  logRetentionDays: 7,
  maxBodyCaptureBytes: 65536,
  maxRecords: 200,
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
  var promptTokens = num(usage.prompt_tokens) ?? num(usage.input_tokens);
  var completionTokens = num(usage.completion_tokens) ?? num(usage.output_tokens);
  var totalTokens = num(usage.total_tokens);
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

function writeRows(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  var body = "";
  for (var i = 0; i < rows.length; i++) {
    body += JSON.stringify(rows[i]) + "\n";
  }
  var tmp = file + ".tmp";
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
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
      hasRequest = true;
    }
    if (responseValue !== undefined) {
      var resCloned = safeCloneBody(redact(responseValue, secrets), settings.maxBodyCaptureBytes);
      bodyFile.response = resCloned.value;
      responseTruncated = resCloned.truncated;
      hasResponse = true;
    }
    if (hasRequest || hasResponse) {
      fs.mkdirSync(paths.bodiesDir, { recursive: true });
      fs.writeFileSync(path.join(paths.bodiesDir, id + ".json"), JSON.stringify(bodyFile), "utf8");
    }
  }

  var row = {
    id: id,
    startedAt: startedAt,
    completedAt: completedAt,
    ok: ok,
    status: status,
    inboundEndpoint: typeof src.inboundEndpoint === "string" ? src.inboundEndpoint : "/v1/chat/completions",
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
  if (usage) {
    if (usage.promptTokens !== undefined) row.promptTokens = usage.promptTokens;
    if (usage.completionTokens !== undefined) row.completionTokens = usage.completionTokens;
    if (usage.totalTokens !== undefined) row.totalTokens = usage.totalTokens;
  }

  var rows = readRows(paths.requestLog);
  rows.push(row);
  var kept = pruneRows(rows, settings);
  writeRows(paths.requestLog, kept);
  unlinkOrphans(paths.bodiesDir, kept);
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
    };
  } catch (err) {
    return { items: [], total: 0, page: 1, pageSize: 50 };
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
