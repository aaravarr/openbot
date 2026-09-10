"use strict";

var fs = require("fs");
var http = require("http");
var https = require("https");
var nodeCrypto = require("crypto");
var { URL } = require("url");
var path = require("path");
var { toOpenAIMessages, sanitizeToolCallIds } = require("./openai-messages.cjs");
var {
  enrichImageReads,
  enforceImageBudget,
  MAX_REQUEST_WIRE_BYTES,
  WIRE_HEADROOM_BYTES,
} = require("./image-read.cjs");
var { applyOpenBotVersionHeader } = require("./version.cjs");
var requestLog = require("./request-log.cjs");
var botModels = require("./bot-models.cjs");
var protocolConverters = require("./protocol-converters.cjs");

var TIMEOUT_MS = Number(process.env.OPENBOT_HOP_TIMEOUT || "1800000");
var HIGH_AGENT_MAX_TOKENS = 65536;

// Global safety ceiling for outbound max_tokens. No shipping
// chat/completions provider accepts a larger single completion (largest
// known maxima are ~128K output); catalog rows come from third-party
// aggregators that occasionally report the context window (or a
// context-minus-prompt remainder, e.g. the 943718 seen on
// meta/muse-spark-1.3-contributor in 2026-09) in a max-completion field.
// Anything above this is data corruption, never a real model limit.
// (Mirrors MAX_OUTPUT_TOKENS_CEILING in src/domain/types.ts; payload is
// zero-dependency CJS injected into the host, so the constant is duplicated
// rather than imported.)
var MAX_OUTPUT_TOKENS_CEILING = 131072;

/** Policy for retrying upstream HTTP 429 before any client bytes are sent. */
var UPSTREAM_429_RETRY = {
  maxRetries: 3,
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 8000,
  budgetMs: 30000,
};

/** Retry policy for upstream 5xx and network-layer failures, while the
 * response is still fully buffered (no client byte written yet).
 *
 * budgetMs bounds TOTAL BACKOFF SLEEP, not wall-clock since the first
 * attempt: a slow failure (e.g. Cloudflare 524 arriving after ~100s of
 * origin timeout) must still get its maxRetries retries — gating on
 * wall-clock would exhaust the budget before any retry happens. Fast
 * failures are bounded by maxRetries plus the sleep budget. The runtime
 * adds its own bounded retries on top. */
var UPSTREAM_5XX_RETRY = {
  maxRetries: 2,
  baseDelayMs: 500,
  factor: 3,
  maxDelayMs: 5000,
  budgetMs: 10000,
};

function isRetryableUpstreamStatus(status) {
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  // Cloudflare edge errors 520-527 (522/524 = origin unreachable/timed out)
  // are transient gateway weather, retryable like a 502. 525 (SSL handshake)
  // and 521 (web server down) are excluded: they indicate config issues where
  // an immediate retry only adds latency.
  return status === 520 || status === 522 || status === 523 || status === 524 || status === 526 || status === 527;
}

function isRetryableUpstreamError(err) {
  if (!err) return false;
  if (err instanceof Error && err.message === "openbot-hop: upstream timeout") return true;
  var code = typeof err.code === "string" ? err.code : "";
  if (code === "ECONNREFUSED") return true;
  if (code === "ECONNRESET" || code === "ECONNABORTED" || code === "ETIMEDOUT") return true;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EAI_AGAIN" || code === "EPIPE") return true;
  var msg = typeof err.message === "string" ? err.message : "";
  if (msg.indexOf("socket hang up") !== -1) return true;
  if (msg.indexOf("ECONNRESET") !== -1 || msg.indexOf("ETIMEDOUT") !== -1) return true;
  return false;
}

function headerValue(headers, name) {
  if (!headers) return "";
  var lower = name.toLowerCase();
  var keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === lower) {
      var value = headers[keys[i]];
      if (Array.isArray(value)) return value.length ? String(value[0]) : "";
      if (value === undefined || value === null) return "";
      return String(value);
    }
  }
  return "";
}

function parseRetryAfterMs(headers, nowMs) {
  var raw = headerValue(headers, "retry-after").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    return Math.max(0, Number(raw) * 1000);
  }
  var when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - (Number.isFinite(nowMs) ? nowMs : Date.now()));
}

function exponentialBackoffMs(attemptIndex) {
  var policy = arguments.length > 1 && arguments[1] ? arguments[1] : UPSTREAM_429_RETRY;
  var exp = policy.baseDelayMs * Math.pow(policy.factor, attemptIndex);
  var capped = Math.min(policy.maxDelayMs, exp);
  var jittered = capped * (0.5 + Math.random() * 0.5);
  return Math.max(0, Math.floor(jittered));
}

function delayBefore429RetryMs(attemptIndex, headers, nowMs, sleepSpentMs) {
  var retryAfter = parseRetryAfterMs(headers, nowMs);
  var policy = UPSTREAM_429_RETRY;
  var delay = retryAfter === null ? exponentialBackoffMs(attemptIndex, policy) : retryAfter;
  var remaining = policy.budgetMs - Math.max(0, Number(sleepSpentMs) || 0);
  if (remaining <= 0) return null;
  return Math.min(delay, remaining);
}

function delayBefore5xxRetryMs(attemptIndex, headers, nowMs, sleepSpentMs) {
  var retryAfter = parseRetryAfterMs(headers, nowMs);
  var policy = UPSTREAM_5XX_RETRY;
  var delay = retryAfter === null ? exponentialBackoffMs(attemptIndex, policy) : retryAfter;
  var remaining = policy.budgetMs - Math.max(0, Number(sleepSpentMs) || 0);
  if (remaining <= 0) return null;
  return Math.min(delay, remaining);
}

function sleepMs(ms) {
  var wait = Math.max(0, Number(ms) || 0);
  if (wait === 0) return Promise.resolve();
  return new Promise(function (resolve) {
    setTimeout(resolve, wait);
  });
}

/** Record how many upstream retries were spent on this attempt chain so the
 * handler can surface it in the request log without changing the log API. */
function tagHopRetries(err, attemptIndex) {
  if (err && attemptIndex > 0) {
    try {
      err.hopRetries = attemptIndex;
    } catch (ignored) {
      /* frozen error objects just skip the annotation */
    }
  }
  return err;
}

function canRetryUpstream429(status, attemptIndex, clientRes, sleepSpentMs) {
  if (status !== 429) return false;
  var policy = UPSTREAM_429_RETRY;
  if (attemptIndex >= policy.maxRetries) return false;
  if (clientRes && clientRes.headersSent) return false;
  // The budget bounds backoff sleep only; attempt wall-time never counts, so a
  // slow 429 (or a slow 5xx) still earns its retries.
  if (sleepSpentMs >= policy.budgetMs) return false;
  return true;
}

function canRetryUpstreamStatus(status, attemptIndex, clientRes, sleepSpentMs) {
  if (!isRetryableUpstreamStatus(status)) return false;
  var policy = UPSTREAM_5XX_RETRY;
  if (attemptIndex >= policy.maxRetries) return false;
  if (clientRes && clientRes.headersSent) return false;
  if (sleepSpentMs >= policy.budgetMs) return false;
  return true;
}

function canRetryUpstreamError(err, attemptIndex, clientRes, sleepSpentMs) {
  if (!isRetryableUpstreamError(err)) return false;
  if (attemptIndex >= UPSTREAM_5XX_RETRY.maxRetries) return false;
  if (clientRes && clientRes.headersSent) return false;
  if (sleepSpentMs >= UPSTREAM_5XX_RETRY.budgetMs) return false;
  return true;
}

function retryAfterForwardHeaders(upstreamHeaders) {
  var raw = headerValue(upstreamHeaders, "retry-after");
  var requestId = headerValue(upstreamHeaders, "x-request-id");
  if (!raw && !requestId) return undefined;
  var out = {};
  if (raw) out["Retry-After"] = raw;
  if (requestId) out["x-request-id"] = requestId;
  return out;
}

// ---- Request source metadata (task: record every clue the hop sees). ----
//
// The OpenAI-compatible hop protocol carries no bot / group-chat identity,
// so the best available clues are the inbound headers (User-Agent, x-*
// SDK headers, forwarding headers) plus body-level conversation keys some
// callers attach. Everything here is best-effort and redaction-safe (no
// secrets: Authorization / api keys are never copied).
function detectClientName(userAgent, headers) {
  var ua = String(userAgent || "").toLowerCase();
  if (ua.indexOf("claude-cli") !== -1 || ua.indexOf("claude-code") !== -1) return "Claude Code";
  if (ua.indexOf("cursor") !== -1) return "Cursor";
  if (ua.indexOf("opencode") !== -1) return "OpenCode";
  if (ua.indexOf("cline") !== -1 || ua.indexOf("vscode") !== -1) return "Cline";
  if (ua.indexOf("aider") !== -1) return "Aider";
  if (ua.indexOf("windsurf") !== -1) return "Windsurf";
  if (ua.indexOf("zed") !== -1) return "Zed";
  if (ua.indexOf("apifox") !== -1) return "Apifox";
  if (ua.indexOf("openbot") !== -1) return "OpenBot";
  if (ua.indexOf("openai") !== -1 || ua.indexOf("stainless") !== -1) {
    var lang = headerValue(headers, "x-stainless-lang");
    return lang ? "OpenAI SDK (" + lang + ")" : "OpenAI SDK";
  }
  if (ua.indexOf("curl") !== -1) return "curl";
  if (
    ua.indexOf("mozilla") !== -1 ||
    ua.indexOf("chrome") !== -1 ||
    ua.indexOf("safari") !== -1 ||
    ua.indexOf("edge") !== -1 ||
    ua.indexOf("firefox") !== -1
  ) {
    return "Browser";
  }
  return "";
}

function parseClientVersion(userAgent) {
  var ua = String(userAgent || "");
  var m = ua.match(/\/v?(\d+\.\d[\w.\-]*)/);
  return m ? m[1].slice(0, 40) : "";
}

function findConversationId(body) {
  if (!isRecord(body)) return "";
  var keys = ["conversationId", "conversation_id", "sessionId", "session_id", "chatId", "chat_id"];
  for (var i = 0; i < keys.length; i++) {
    var value = body[keys[i]];
    if (typeof value === "string" && value && value.length <= 128) return value;
  }
  return "";
}

// Deterministic OpenCode Zen session id per provider + conversation. The
// upstream requires x-opencode-session since 2026-09-07 (MissingSessionID 400).
// Identity is derived only from box-owned values: the routed provider id and
// the conversation id already extracted for the request log. Inbound client
// headers are never promoted to cross-request identity, so a caller cannot
// forge or rotate another conversation's session. Requests without a
// conversation id fall back to one fresh UUID per request; they are stateless
// one-shot turns, so a stable id would be meaningless there.
function opencodeSessionId(providerId, conversationId) {
  var scope = String(providerId || "") + "\n" + String(conversationId || "");
  var hex = nodeCrypto.createHash("sha256").update("openbot-opencode-session\0" + scope, "utf8").digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][parseInt(hex[16], 16) & 3];
  var compact = hex.join("");
  return compact.slice(0, 8) + "-" + compact.slice(8, 12) + "-" + compact.slice(12, 16) + "-" + compact.slice(16, 20) + "-" + compact.slice(20);
}

function inboundClientMeta(req, body) {
  var headers = (req && req.headers) || {};
  var userAgent = headerValue(headers, "user-agent");
  var forwarded = headerValue(headers, "x-forwarded-for").split(",")[0].trim();
  return {
    userAgent: userAgent,
    clientName: detectClientName(userAgent, headers),
    clientVersion: parseClientVersion(userAgent),
    conversationId: findConversationId(body),
    origin: forwarded || headerValue(headers, "x-real-ip").trim(),
    requestId: headerValue(headers, "x-request-id").slice(0, 128),
  };
}

function hasSseContent(parsed) {
  try {
    if (requestLog && typeof requestLog.sseChunkHasContent === "function") {
      return requestLog.sseChunkHasContent(parsed);
    }
  } catch (err) {
    /* fall through to the permissive fallback */
  }
  return true;
}

// Incremental first-content scan for a live SSE forward: appends the chunk,
// drains complete lines, and returns Date.now() the moment a data frame
// carries real model output. Unparseable lines are skipped; the buffer is
// capped so a pathological single line cannot grow it without bound.
function noteFirstContent(state, chunk) {
  state.buf += chunk.toString("utf8");
  if (state.buf.length > 65536) state.buf = state.buf.slice(state.buf.length - 65536);
  var nl = state.buf.indexOf("\n");
  while (nl >= 0) {
    var line = state.buf.slice(0, nl);
    state.buf = state.buf.slice(nl + 1);
    if (line.indexOf("data:") === 0) {
      var data = line.slice(5).trim();
      if (data && data !== "[DONE]") {
        var parsed;
        try {
          parsed = JSON.parse(data);
        } catch (err) {
          parsed = undefined;
        }
        if (parsed !== undefined && hasSseContent(parsed)) return Date.now();
      }
    }
    nl = state.buf.indexOf("\n");
  }
  return 0;
}

function planPath() {
  return process.env.OPENBOT_PLAN || "/home/box/sand-data/openbot-plan.json";
}

function sandDataDir() {
  if (process.env.OPENBOT_SAND_DATA) return process.env.OPENBOT_SAND_DATA;
  if (process.env.OPENBOT_PLAN) return path.dirname(process.env.OPENBOT_PLAN);
  return "/home/box/sand-data";
}

function pausePath() {
  if (process.env.OPENBOT_PAUSE) return process.env.OPENBOT_PAUSE;
  return path.join(sandDataDir(), "openbot-pause.json");
}

// Global gateway pause flag. Read synchronously on every completions
// request so flipping the switch takes effect without a hop restart.
// Missing file = not paused. Corrupt JSON = not paused (fail open: a
// half-written pause file must never wedge the gateway shut).
function readPauseState() {
  try {
    var raw = fs.readFileSync(pausePath(), "utf8");
    var parsed = JSON.parse(raw);
    return parsed && parsed.paused === true;
  } catch (err) {
    return false;
  }
}

function pauseBotsPath() {
  if (process.env.OPENBOT_PAUSE_BOTS) return process.env.OPENBOT_PAUSE_BOTS;
  return path.join(sandDataDir(), "openbot-pause-bots.json");
}

function readPauseBotsState() {
  try {
    var parsed = JSON.parse(fs.readFileSync(pauseBotsPath(), "utf8"));
    if (!parsed || !Array.isArray(parsed.pausedBotIds)) return [];
    return parsed.pausedBotIds.filter(function (id) { return typeof id === "string" && id.trim(); });
  } catch (err) {
    return [];
  }
}

function isBotPaused(botId) {
  return typeof botId === "string" && readPauseBotsState().indexOf(botId) >= 0;
}

function secretsPath() {
  return process.env.OPENBOT_SECRETS || "/home/box/sand-data/secrets.json";
}

function mapsPath() {
  return process.env.OPENBOT_MAPS || path.join(__dirname, "provider-maps.cjs");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathnameOf(req) {
  try {
    return new URL(req.url || "/", "http://127.0.0.1").pathname;
  } catch (err) {
    return "/";
  }
}

function completionsUrl(origin) {
  var b = String(origin || "").replace(/\/+$/, "");
  if (!b) throw new Error("openbot-hop: missing origin");
  if (/\/chat\/completions$/i.test(b)) return b;
  if (/\/v1$/i.test(b) || /\/v4$/i.test(b) || /\/paas\/v4$/i.test(b)) return b + "/chat/completions";
  return b + "/v1/chat/completions";
}

function upstreamUrl(origin, apiType) {
  var b = String(origin || "").replace(/\/+$/, "");
  if (!b) throw new Error("openbot-hop: missing origin");
  if (apiType === "responses") return /\/responses$/i.test(b) ? b : (/\/v1$/i.test(b) ? b + "/responses" : b + "/v1/responses");
  if (apiType === "anthropic") return /\/messages$/i.test(b) ? b : (/\/v1$/i.test(b) ? b + "/messages" : b + "/v1/messages");
  return completionsUrl(b);
}

function findById(rows, id) {
  for (var i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].id === id) return rows[i];
  }
  return null;
}

function lookupRoute(plan, requested) {
  var catalog = plan && plan.catalog;
  var models = (catalog && catalog.models) || [];
  var providers = (catalog && catalog.providers) || [];
  var agents = (plan && plan.agents) || {};
  var wildcard = agents["*"];

  function routeFor(model) {
    if (!model) return null;
    var provider = findById(providers, model.providerId);
    if (!provider) return null;
    return { model: model, provider: provider };
  }

  if (wildcard && typeof wildcard.modelId === "string") {
    var bound = null;
    for (var i = 0; i < models.length; i++) {
      var row = models[i];
      if (!row) continue;
      if (row.providerId !== wildcard.providerId) continue;
      if (row.slug === wildcard.modelId || row.id === wildcard.modelId) {
        bound = row;
        break;
      }
    }
    if (bound && (requested === bound.slug || requested === bound.id || requested === wildcard.modelId)) {
      return routeFor(bound);
    }
  }

  var byId = findById(models, requested);
  if (byId) return routeFor(byId);
  for (var j = 0; j < models.length; j++) {
    if (models[j] && models[j].slug === requested) {
      return routeFor(models[j]);
    }
  }
  return null;
}

function loadStoredSecret(providerId) {
  var store = readJson(secretsPath());
  var providers = store && store.providers;
  if (!isRecord(providers) || typeof providers[providerId] !== "string") {
    return "";
  }
  return providers[providerId];
}

function resolveUpstreamUrl(provider, isOpenAIOAuth, apiType) {
  if (isOpenAIOAuth) return "https://chatgpt.com/backend-api/codex/responses";
  return upstreamUrl(provider && provider.origin, apiType);
}

function openAIOAuthAccountId(credential) {
  if (!isRecord(credential)) return "";
  if (typeof credential.chatgptAccountId === "string" && credential.chatgptAccountId.trim()) return credential.chatgptAccountId.trim();
  var tokens = [credential.idToken, credential.accessToken];
  for (var i = 0; i < tokens.length; i++) {
    try {
      var parts = String(tokens[i] || "").split(".");
      if (parts.length < 2) continue;
      var claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      var auth = claims && isRecord(claims["https://api.openai.com/auth"]) ? claims["https://api.openai.com/auth"] : null;
      if (auth && typeof auth.chatgpt_account_id === "string" && auth.chatgpt_account_id.trim()) return auth.chatgpt_account_id.trim();
    } catch (err) { /* a non-JWT token simply has no embedded account id */ }
  }
  return "";
}

function readOpenAIOAuthCredential(providerId) {
  if (providerId !== "openai") return null;
  var raw = loadStoredSecret(providerId);
  try {
    var parsed = JSON.parse(raw);
    return isRecord(parsed) && parsed.kind === "openai-oauth" ? parsed : null;
  } catch (err) { return null; }
}

function requestOAuthRefresh(refreshToken) {
  return new Promise(function (resolve, reject) {
    var payload = Buffer.from("grant_type=refresh_token&client_id=app_EMoamEEZ73f0CkXaXp7hrann&refresh_token=" + encodeURIComponent(refreshToken), "utf8");
    var req = https.request({
      hostname: "auth.openai.com", path: "/oauth/token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(payload.length), Accept: "application/json" },
    }, function (res) {
      collectResponse(res).then(function (out) {
        var parsed;
        try { parsed = JSON.parse(out.raw.toString("utf8")); } catch (err) { parsed = null; }
        if ((out.status || 500) < 200 || (out.status || 500) >= 300 || !parsed || typeof parsed.access_token !== "string") {
          reject(new Error("openbot-hop: OpenAI OAuth refresh failed"));
          return;
        }
        resolve(parsed);
      }, reject);
    });
    req.on("error", reject);
    req.setTimeout(TIMEOUT_MS, function () { req.destroy(new Error("openbot-hop: OAuth refresh timeout")); });
    req.end(payload);
  });
}

// Persist a rotated OAuth credential. Returns true when the new value is on
// disk; a false return means the caller must treat the refresh as failed so a
// later request never proceeds with an access token that was not persisted.
function saveStoredSecret(providerId, value) {
  try {
    var file = secretsPath();
    var store = readJson(file) || { providers: {} };
    if (!isRecord(store.providers)) store.providers = {};
    store.providers[providerId] = value;
    var tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (err) { /* refresh persistence is best-effort; the request still uses the new token */ }
  return false;
}

// Per-provider single-flight refresh. Concurrent requests share one token
// exchange, so a rotating refresh token is written exactly once and no later
// writer can overwrite it with credentials minted from the now-consumed token.
var oauthRefreshFlights = {};

function refreshOpenAIOAuthCredential(providerId, parsed) {
  if (oauthRefreshFlights[providerId]) return oauthRefreshFlights[providerId];
  var flight = requestOAuthRefresh(parsed.refreshToken)
    .then(function (refreshed) {
      var next = Object.assign({}, parsed, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || parsed.refreshToken,
        expiresAt: Math.floor(Date.now() / 1000) + Math.max(1, Number(refreshed.expires_in) || 3600),
      });
      var refreshedAccountId = openAIOAuthAccountId({ idToken: refreshed.id_token, accessToken: refreshed.access_token });
      if (refreshedAccountId) next.chatgptAccountId = refreshedAccountId;
      if (!saveStoredSecret(providerId, JSON.stringify(next))) {
        throw new Error("openbot-hop: OpenAI OAuth credential was not persisted");
      }
      return next.accessToken;
    })
    .finally(function () {
      delete oauthRefreshFlights[providerId];
    });
  oauthRefreshFlights[providerId] = flight;
  return flight;
}

async function loadKey(providerId, provider) {
  var raw = loadStoredSecret(providerId);
  if (!raw) return "";
  if (providerId !== "openai") return raw;
  var parsed;
  try { parsed = JSON.parse(raw); } catch (err) { return raw; }
  if (!isRecord(parsed) || parsed.kind !== "openai-oauth" || typeof parsed.accessToken !== "string") return raw;
  var expiresAt = Number(parsed.expiresAt || 0);
  if (expiresAt > Math.floor(Date.now() / 1000) + 60) return parsed.accessToken;
  if (typeof parsed.refreshToken !== "string" || !parsed.refreshToken) {
    throw new Error("openbot-hop: OpenAI OAuth credential is expired with no refresh token");
  }
  try {
    return await refreshOpenAIOAuthCredential(providerId, parsed);
  } catch (err) {
    throw new Error("openbot-hop: OpenAI OAuth refresh failed (" + err.message + ")");
  }
}

function levelsHaveDefault(model) {
  var levels = model && model.reasoningLevels;
  if (!Array.isArray(levels)) return false;
  for (var i = 0; i < levels.length; i++) {
    if (levels[i] === "default") return true;
  }
  return false;
}

function hopReasoning(model) {
  var level = model && typeof model.activeReasoning === "string" ? model.activeReasoning : "";
  if (!levelsHaveDefault(model) && (level === "" || level === "none")) {
    return "default";
  }
  if (!level) return "default";
  return level;
}

function hopParameters(model) {
  var params = [];
  var rows = model && model.parameters;
  if (Array.isArray(rows)) {
    for (var i = 0; i < rows.length; i++) {
      var p = rows[i];
      if (!p || !p.id) continue;
      if (p.id === "effort" || p.id === "thinking") continue;
      params.push(p);
    }
  }
  var level = hopReasoning(model);
  if (level === "default") {
    return params;
  }
  if (level === "none") {
    params.push({ id: "thinking", value: "false" });
    return params;
  }
  params.push({ id: "effort", value: String(level) });
  return params;
}

function applyMaxTokens(body, model, apiType) {
  // Generic outbound governance (all providers): the model cap itself is
  // clamped to the global ceiling first, because a poisoned catalog row
  // (e.g. 943718) would otherwise pass a self-comparison and sail through.
  // Missing/unreliable caps fall back to HIGH_AGENT_MAX_TOKENS (existing
  // default); the ceiling only truncates, never inflates.
  var rawCap = Number(model && model.maxOutputTokens);
  var cap = HIGH_AGENT_MAX_TOKENS;
  if (Number.isFinite(rawCap) && rawCap > 0) {
    cap = Math.min(Math.floor(rawCap), MAX_OUTPUT_TOKENS_CEILING);
  }
  var requested = Number(apiType === "responses" ? (body.max_output_tokens !== undefined ? body.max_output_tokens : body.max_tokens) : body.max_tokens);
  if (!Number.isFinite(requested) || requested <= 0) {
    if (apiType === "responses") body.max_output_tokens = cap; else body.max_tokens = cap;
    return;
  }
  if (requested > cap) { if (apiType === "responses") body.max_output_tokens = cap; else body.max_tokens = cap; }
}

function applyMaps(body, ctx) {
  var maps;
  try {
    delete require.cache[require.resolve(mapsPath())];
    maps = require(mapsPath());
  } catch (err) {
    return;
  }
  if (maps && typeof maps.applyProviderReasoningControls === "function") {
    maps.applyProviderReasoningControls(body, ctx);
  }
}

// Serialized size of the outbound body WITHOUT its messages: tools, model,
// stream and every other envelope field. The image governance pass subtracts
// this from its wire budget, so the 4 MiB limit is enforced on the full
// outbound wire (messages + tools + envelope), not on messages alone — the
// 2026-09-04 incident body passed a messages-only check by a few KB and still
// 413'd once the ~230 KB of tools were added on top.
function outboundEnvelopeBytes(body) {
  try {
    var envelope = {};
    for (var key in body) {
      if (Object.prototype.hasOwnProperty.call(body, key) && key !== "messages") {
        envelope[key] = body[key];
      }
    }
    envelope.messages = [];
    return Buffer.byteLength(JSON.stringify(envelope), "utf8");
  } catch (err) {
    return 0;
  }
}

// Advisory only: after governance, max_tokens and the provider parameter maps
// have been applied, so this is the wire the upstream actually receives. The
// governance budget already reserved WIRE_HEADROOM_BYTES for these additions;
// if this still fires, the body carries oversized non-image content no image
// pass can shrink, and the log names it instead of letting a 413 explain it.
function noteWireBytes(body) {
  try {
    var bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    if (bytes > MAX_REQUEST_WIRE_BYTES) {
      process.stderr.write(
        "openbot-hop outbound wire is " + bytes + " bytes, over the " +
        MAX_REQUEST_WIRE_BYTES + " byte budget (non-image content too large)\n",
      );
    }
  } catch (err) {
    /* advisory only, never throw into the chat path */
  }
}

function headerContentType(headers) {
  if (!headers) return "";
  return String(headers["content-type"] || headers["Content-Type"] || "");
}

function looksLikeEventStream(headers, wantStream) {
  var ctype = headerContentType(headers);
  if (/text\/event-stream/i.test(ctype)) return true;
  if (wantStream && !/application\/json/i.test(ctype)) return true;
  return false;
}

function hopAccept(wantStream) {
  return wantStream ? "text/event-stream, application/json" : "application/json";
}

function inboundUserAgent(inbound) {
  if (!inbound || !inbound.headers) return "";
  var ua = inbound.headers["user-agent"];
  if (typeof ua === "string" && ua.trim()) return ua;
  return "";
}

function openUpstream(urlStr, body, key, inbound, apiType) {
  var u = new URL(urlStr);
  var lib = u.protocol === "https:" ? https : http;
  var outboundBody = Object.assign({}, body);
  delete outboundBody.__openbot_api_type;
  var payload = Buffer.from(JSON.stringify(outboundBody), "utf8");
  var wantStream = body && body.stream === true;
  var headers = {
    "Content-Type": "application/json",
    "Content-Length": String(payload.length),
    "Accept": hopAccept(wantStream),
    "Accept-Encoding": "identity",
  };
  if (key) {
    headers.Authorization = "Bearer " + key;
    if (apiType === "anthropic") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      delete headers.Authorization;
    }
  }
  var origin = String((inbound && inbound.providerOrigin) || "");
  var providerId = String((inbound && inbound.providerId) || "");
  var isOpenAIOAuth = inbound && inbound.openaiOAuth === true;
  if (isOpenAIOAuth) {
    headers["User-Agent"] = "codex-tui/0.153.3 (Mac OS 26.5.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.153.3)";
    headers.originator = "codex-tui";
    if (inbound.chatgptAccountId) headers["chatgpt-account-id"] = inbound.chatgptAccountId;
  }
  if (providerId === "opencode" && inbound && inbound.opencodeSession) {
    headers["x-opencode-session"] = inbound.opencodeSession;
  }
  if (providerId === "openrouter") {
    headers["HTTP-Referer"] = "https://openbot.local";
    headers["X-Title"] = "OpenBot";
  }
  applyOpenBotVersionHeader(headers);
  var ua = inboundUserAgent(inbound);
  if (ua && !isOpenAIOAuth) headers["User-Agent"] = ua;
  var req = lib.request({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: u.pathname + u.search,
    method: "POST",
    headers: headers,
  });
  req.write(payload);
  return req;
}

function collectResponse(res) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    res.on("data", function (c) { chunks.push(c); });
    res.on("end", function () {
      resolve({ status: res.statusCode || 502, headers: res.headers, raw: Buffer.concat(chunks) });
    });
    res.on("error", reject);
  });
}

function postUpstreamOnce(urlStr, body, key, inbound, apiType) {
  return new Promise(function (resolve, reject) {
    var req = openUpstream(urlStr, body, key, inbound, apiType);
    req.setTimeout(TIMEOUT_MS, function () {
      req.destroy();
      reject(new Error("openbot-hop: upstream timeout"));
    });
    req.on("error", reject);
    req.on("response", function (res) {
      collectResponse(res).then(resolve, reject);
    });
    req.end();
  });
}

/** Same shape as postUpstreamOnce, but a network-layer failure or a retryable
 * status never rejects: it resolves with an attemptFailed marker so the retry
 * loop can count it without aborting the chain. */
async function postUpstreamAttempt(urlStr, body, key, inbound, apiType) {
  try {
    var out = await postUpstreamOnce(urlStr, body, key, inbound, apiType);
    if (isRetryableUpstreamStatus(out.status)) {
      return { attemptFailed: true, status: out.status, headers: out.headers, raw: out.raw };
    }
    return out;
  } catch (err) {
    if (!isRetryableUpstreamError(err)) throw err;
    return { attemptFailed: true, status: 0, headers: {}, raw: Buffer.alloc(0), attemptError: err };
  }
}

async function postUpstream(urlStr, body, key, inbound, apiType) {
  var attemptIndex = 0;
  var retriesSpent = 0;
  // Retry allowance is measured in backoff sleep, not wall clock: an attempt
  // that takes 100s+ to fail (Cloudflare 524 origin timeout) must still get
  // its retries instead of exhausting the budget before sleeping once.
  var sleepSpentMs = 0;
  // Per-attempt chain for the request log: every upstream try records its
  // status / error / latency so retries are visible instead of collapsing
  // into a single "upstream-retries=N" suffix.
  var attempts = [];
  function withAttempts(out) {
    if (attempts.length) {
      out.attempts = attempts;
      out.attemptCount = attempts.length;
    }
    return out;
  }
  while (true) {
    var attemptStartedMs = Date.now();
    var out;
    try {
      out = await postUpstreamOnce(urlStr, body, key, inbound, apiType);
    } catch (err) {
      if (!canRetryUpstreamError(err, attemptIndex, null, sleepSpentMs)) {
        attempts.push({
          attempt: attemptIndex + 1,
          status: 0,
          error: errorMessage(err, "hop failed"),
          latencyMs: Date.now() - attemptStartedMs,
          decision: "final",
        });
        throw tagHopRetries(err, attemptIndex);
      }
      out = { attemptFailed: true, status: 0, headers: {}, raw: Buffer.alloc(0), attemptError: err };
    }
    if (!out.attemptFailed) {
      var retryKind = classifyUpstreamRetry(out.status, attemptIndex, null, sleepSpentMs);
      if (retryKind === null) {
        attempts.push({
          attempt: attemptIndex + 1,
          status: out.status,
          latencyMs: Date.now() - attemptStartedMs,
          decision: "final",
        });
        if (retriesSpent > 0) out.hopRetries = retriesSpent;
        return withAttempts(out);
      }
      var delay = retryDelayMs(retryKind, attemptIndex, out.headers, Date.now(), sleepSpentMs);
      if (delay === null) {
        attempts.push({
          attempt: attemptIndex + 1,
          status: out.status,
          latencyMs: Date.now() - attemptStartedMs,
          decision: "final",
        });
        if (retriesSpent > 0) out.hopRetries = retriesSpent;
        return withAttempts(out);
      }
      attempts.push({
        attempt: attemptIndex + 1,
        status: out.status,
        latencyMs: Date.now() - attemptStartedMs,
        decision: "retry",
      });
      await sleepMs(delay);
      sleepSpentMs += delay;
      attemptIndex += 1;
      retriesSpent = attemptIndex;
      continue;
    }
    var delayErr = delayBefore5xxRetryMs(attemptIndex, out.headers, Date.now(), sleepSpentMs);
    if (delayErr === null) {
      attempts.push({
        attempt: attemptIndex + 1,
        status: out.status || 0,
        error: errorMessage(out.attemptError, "hop failed"),
        latencyMs: Date.now() - attemptStartedMs,
        decision: "final",
      });
      throw tagHopRetries(out.attemptError, attemptIndex);
    }
    attempts.push({
      attempt: attemptIndex + 1,
      status: out.status || 0,
      error: errorMessage(out.attemptError, "hop failed"),
      latencyMs: Date.now() - attemptStartedMs,
      decision: "retry",
    });
    await sleepMs(delayErr);
    sleepSpentMs += delayErr;
    attemptIndex += 1;
    retriesSpent = attemptIndex;
  }
}

function classifyUpstreamRetry(status, attemptIndex, clientRes, sleepSpentMs) {
  if (canRetryUpstream429(status, attemptIndex, clientRes, sleepSpentMs)) return "429";
  if (isRetryableUpstreamStatus(status) && canRetryUpstreamStatus(status, attemptIndex, clientRes, sleepSpentMs)) {
    return "5xx";
  }
  return null;
}

function retryDelayMs(kind, attemptIndex, headers, nowMs, sleepSpentMs) {
  if (kind === "429") return delayBefore429RetryMs(attemptIndex, headers, nowMs, sleepSpentMs);
  return delayBefore5xxRetryMs(attemptIndex, headers, nowMs, sleepSpentMs);
}

function pipeOrBufferUpstreamOnce(urlStr, body, key, clientRes, inbound, activeReq, transformResponse) {
  return new Promise(function (resolve, reject) {
    var req = openUpstream(urlStr, body, key, inbound, body && body.__openbot_api_type);
    if (activeReq) activeReq.current = req;
    var settled = false;
    function fail(err) {
      if (settled) return;
      settled = true;
      if (activeReq && activeReq.current === req) activeReq.current = null;
      reject(err);
    }
    function ok(value) {
      if (settled) return;
      settled = true;
      if (activeReq && activeReq.current === req) activeReq.current = null;
      resolve(value);
    }
    req.setTimeout(TIMEOUT_MS, function () {
      req.destroy();
      fail(new Error("openbot-hop: upstream timeout"));
    });
    req.on("error", fail);
    req.on("response", function (res) {
      var status = res.statusCode || 502;
      // Retryable statuses are decided before any client byte. Collect and
      // return without writeHead so the caller can retry while headersSent
      // is false.
      if (status === 429 || isRetryableUpstreamStatus(status)) {
        collectResponse(res).then(ok, fail);
        return;
      }
      if (!looksLikeEventStream(res.headers, true)) {
        collectResponse(res).then(function (out) {
          ok(Object.assign({ forwarded: false }, out));
        }, fail);
        return;
      }
      var ctype = headerContentType(res.headers) || "text/event-stream";
      clientRes.writeHead(status || 200, {
        "Content-Type": ctype,
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      if (typeof clientRes.flushHeaders === "function") clientRes.flushHeaders();
      var chunks = [];
      var scanState = { buf: "" };
      var firstContentAt = 0;
      res.on("data", function (c) {
        chunks.push(c);
        if (!transformResponse && !clientRes.writableEnded) clientRes.write(c);
        if (!firstContentAt) {
          var at = noteFirstContent(scanState, c);
          if (at) firstContentAt = at;
        }
      });
      res.on("end", function () {
        if (!clientRes.writableEnded) {
          var outgoing = transformResponse ? transformResponse(Buffer.concat(chunks)) : Buffer.concat(chunks);
          if (transformResponse) clientRes.write(outgoing);
          clientRes.end();
        }
        ok({
          status: status || 200,
          headers: res.headers,
          raw: Buffer.concat(chunks),
          forwarded: true,
          firstContentAt: firstContentAt,
        });
      });
      res.on("error", fail);
    });
    req.end();
  });
}

async function pipeOrBufferUpstream(urlStr, body, key, clientRes, inbound, transformResponse) {
  var requestStartedMs = Date.now();
  var attemptIndex = 0;
  var activeReq = { current: null };
  var retriesSpent = 0;
  // Same sleep-based budget as postUpstream: slow attempts never eat retries.
  var sleepSpentMs = 0;
  var attempts = [];
  function withAttempts(out) {
    if (attempts.length) {
      out.attempts = attempts;
      out.attemptCount = attempts.length;
    }
    return out;
  }
  function onClientClose() {
    if (!clientRes.writableEnded && activeReq.current) activeReq.current.destroy();
  }
  clientRes.on("close", onClientClose);
  try {
    while (true) {
      var attemptStartedMs = Date.now();
      var out;
      try {
        out = await pipeOrBufferUpstreamOnce(urlStr, body, key, clientRes, inbound, activeReq, transformResponse);
      } catch (err) {
        if (!canRetryUpstreamError(err, attemptIndex, clientRes, sleepSpentMs)) {
          attempts.push({
            attempt: attemptIndex + 1,
            status: 0,
            error: errorMessage(err, "hop failed"),
            latencyMs: Date.now() - attemptStartedMs,
            decision: "final",
          });
          throw tagHopRetries(err, attemptIndex);
        }
        out = { attemptFailed: true, status: 0, headers: {}, raw: Buffer.alloc(0), attemptError: err };
      }
      if (out.attemptFailed) {
        var delay = delayBefore5xxRetryMs(attemptIndex, out.headers, Date.now(), sleepSpentMs);
        if (delay === null) {
          attempts.push({
            attempt: attemptIndex + 1,
            status: out.status || 0,
            error: errorMessage(out.attemptError, "hop failed"),
            latencyMs: Date.now() - attemptStartedMs,
            decision: "final",
          });
          throw tagHopRetries(out.attemptError, attemptIndex);
        }
        attempts.push({
          attempt: attemptIndex + 1,
          status: out.status || 0,
          error: errorMessage(out.attemptError, "hop failed"),
          latencyMs: Date.now() - attemptStartedMs,
          decision: "retry",
        });
        await sleepMs(delay);
        sleepSpentMs += delay;
        attemptIndex += 1;
        retriesSpent = attemptIndex;
        continue;
      }
      if (out.forwarded) {
        attempts.push({
          attempt: attemptIndex + 1,
          status: out.status,
          latencyMs: Date.now() - attemptStartedMs,
          decision: "final",
        });
        if (typeof out.firstContentAt === "number" && out.firstContentAt > 0) {
          out.firstTokenMs = Math.max(0, Math.round(out.firstContentAt - requestStartedMs));
        }
        if (retriesSpent > 0) out.hopRetries = retriesSpent;
        return withAttempts(out);
      }
      var retryKind = classifyUpstreamRetry(out.status, attemptIndex, clientRes, sleepSpentMs);
      if (retryKind === null) {
        attempts.push({
          attempt: attemptIndex + 1,
          status: out.status,
          latencyMs: Date.now() - attemptStartedMs,
          decision: "final",
        });
        if (retriesSpent > 0) out.hopRetries = retriesSpent;
        out = convertBufferedResponse(out, body.__openbot_api_type || "chat-completions");
        if (!clientRes.headersSent) {
          send(clientRes, out.status, out.raw, headerContentType(out.headers) || "application/json", retryAfterForwardHeaders(out.headers));
        }
        return withAttempts(out);
      }
      var retryDelay = retryDelayMs(retryKind, attemptIndex, out.headers, Date.now(), sleepSpentMs);
      if (retryDelay === null) {
        attempts.push({
          attempt: attemptIndex + 1,
          status: out.status,
          latencyMs: Date.now() - attemptStartedMs,
          decision: "final",
        });
        if (retriesSpent > 0) out.hopRetries = retriesSpent;
        out = convertBufferedResponse(out, body.__openbot_api_type || "chat-completions");
        if (!clientRes.headersSent) {
          send(clientRes, out.status, out.raw, headerContentType(out.headers) || "application/json", retryAfterForwardHeaders(out.headers));
        }
        return withAttempts(out);
      }
      attempts.push({
        attempt: attemptIndex + 1,
        status: out.status,
        latencyMs: Date.now() - attemptStartedMs,
        decision: "retry",
      });
      await sleepMs(retryDelay);
      sleepSpentMs += retryDelay;
      attemptIndex += 1;
      retriesSpent = attemptIndex;
    }
  } finally {
    clientRes.removeListener("close", onClientClose);
  }
}

function send(res, status, payload, contentType, extraHeaders) {
  var body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  var headers = {
    "Content-Type": contentType || "application/json",
    "Content-Length": String(body.length),
  };
  if (extraHeaders && typeof extraHeaders === "object") {
    var keys = Object.keys(extraHeaders);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (extraHeaders[k] !== undefined && extraHeaders[k] !== null) {
        headers[k] = String(extraHeaders[k]);
      }
    }
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), "application/json");
}

function convertBufferedResponse(out, apiType) {
  if (!out || apiType === "chat-completions") return out;
  var text = Buffer.isBuffer(out.raw) ? out.raw.toString("utf8") : String(out.raw || "");
  if (out.status < 200 || out.status >= 300) {
    try { out.raw = Buffer.from(JSON.stringify(protocolConverters.mapUpstreamError(JSON.parse(text), out.status)), "utf8"); } catch (err) { /* preserve non-JSON error */ }
    out.headers = Object.assign({}, out.headers, { "content-type": "application/json" });
    return out;
  }
  var eventStream = /(^|\n)(event:|data:)/.test(text) || /text\/event-stream/i.test(headerContentType(out.headers));
  try {
    if (eventStream) text = apiType === "responses" ? protocolConverters.responsesSseToChat(text) : protocolConverters.anthropicSseToChat(text);
    else {
      var parsed = JSON.parse(text);
      parsed = apiType === "responses" ? protocolConverters.responsesToChat(parsed) : protocolConverters.anthropicToChat(parsed);
      text = JSON.stringify(parsed);
    }
    out.raw = Buffer.from(text, "utf8");
    out.headers = Object.assign({}, out.headers, { "content-type": eventStream ? "text/event-stream" : "application/json" });
  } catch (err) { /* preserve upstream response for diagnostics */ }
  return out;
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;
    req.on("data", function (c) {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

function recordHopSafe(entry) {
  try {
    requestLog.recordHop(entry);
  } catch (err) {
    /* never throw into the chat path */
  }
}

function appendEventSafe(entry) {
  try {
    requestLog.appendEvent(entry);
  } catch (err) {
    /* best-effort: a warning write must never break chat */
  }
}

function errorMessage(err, fallback) {
  if (err && typeof err.message === "string" && err.message.trim()) return err.message;
  return fallback || "hop failed";
}

function errorMessageWithRetries(err, fallback) {
  var base = errorMessage(err, fallback);
  var count = err && typeof err.hopRetries === "number" ? err.hopRetries : 0;
  if (count > 0) {
    return base + " [upstream-retries=" + String(count) + "]";
  }
  return base;
}

async function handleCompletions(req, res) {
  var startedMs = Date.now();
  var startedAt = new Date().toISOString();
  var fields = {
    inboundEndpoint: "/v1/chat/completions",
    stream: false,
  };
  var clientMeta = {
    userAgent: "",
    clientName: "",
    clientVersion: "",
    conversationId: "",
    origin: "",
    requestId: "",
  };
  var recorded = false;

  function record(extra) {
    if (recorded) return;
    recorded = true;
    extra = extra || {};
    recordHopSafe({
      startedAt: startedAt,
      completedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedMs,
      inboundEndpoint: fields.inboundEndpoint,
      stream: extra.stream === undefined ? fields.stream : extra.stream,
      model: extra.model !== undefined ? extra.model : fields.model,
      providerId: extra.providerId !== undefined ? extra.providerId : fields.providerId,
      providerName: extra.providerName !== undefined ? extra.providerName : fields.providerName,
      upstreamEndpoint: extra.upstreamEndpoint !== undefined ? extra.upstreamEndpoint : fields.upstreamEndpoint,
      requestBody: extra.requestBody !== undefined ? extra.requestBody : fields.requestBody,
      responseBody: extra.responseBody,
      responseRaw: extra.responseRaw,
      status: extra.status,
      error: extra.error,
      attempts: extra.attempts,
      attemptCount: extra.attemptCount,
      firstTokenMs: extra.firstTokenMs,
      clientName: extra.clientName !== undefined ? extra.clientName : clientMeta.clientName,
      clientVersion: extra.clientVersion !== undefined ? extra.clientVersion : clientMeta.clientVersion,
      userAgent: extra.userAgent !== undefined ? extra.userAgent : clientMeta.userAgent,
      conversationId: extra.conversationId !== undefined ? extra.conversationId : clientMeta.conversationId,
      origin: extra.origin !== undefined ? extra.origin : clientMeta.origin,
      requestId: extra.requestId !== undefined ? extra.requestId : clientMeta.requestId,
    });
  }

  try {
    // Gateway pause gate: fail fast with 503 before touching the body or
    // the plan, so a paused gateway performs no upstream work at all.
    if (readPauseState()) {
      var paused = { error: { message: "openbot gateway paused", code: "paused" } };
      record({
        status: 503,
        error: "openbot gateway paused",
        responseBody: paused,
      });
      sendJson(res, 503, paused);
      return;
    }
    var raw = await readBody(req);
    // Capture header clues even when the JSON body itself is unreadable.
    clientMeta = inboundClientMeta(req, undefined);
    var body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch (err) {
      var invalid = { error: { message: "invalid json" } };
      record({
        status: 400,
        error: "invalid json",
        requestBody: raw.toString("utf8").slice(0, 8000),
        responseBody: invalid,
      });
      sendJson(res, 400, invalid);
      return;
    }
    if (isRecord(body)) {
      fields.stream = body.stream === true;
      if (typeof body.model === "string") fields.model = body.model;
      fields.requestBody = body;
    }
    clientMeta = inboundClientMeta(req, body);
    var botContext = requestLog.extractChatContext && requestLog.extractChatContext(body && body.messages);
    if (botContext && botContext.botId && isBotPaused(botContext.botId)) {
      var botPaused = { error: { message: "openbot bot paused", code: "bot_paused", botId: botContext.botId } };
      record({ status: 503, error: "openbot bot paused", responseBody: botPaused });
      sendJson(res, 503, botPaused);
      return;
    }
    var plan;
    try {
      plan = readJson(planPath());
    } catch (err) {
      var missing = { error: { message: "openbot plan missing; save a provider in the UI" } };
      record({ status: 503, error: missing.error.message, responseBody: missing });
      sendJson(res, 503, missing);
      return;
    }
    // Per-bot model override, resolved before routing. A stale assignment
    // (model removed from the catalog) must never fail the chat: warn once
    // per request and fall back. When the runtime already rewrote body.model
    // to the stale value, fall back to the wildcard (global) binding.
    var requested = body && body.model;
    var assignment = null;
    try {
      assignment = botModels.resolveAssignment(body && body.messages, plan);
    } catch (err) {
      assignment = null;
    }
    if (assignment && assignment.stale) {
      appendEventSafe({
        type: "bot-models.stale",
        severity: "WARN",
        message: "Bot model assignment " + assignment.modelId + " for bot " + assignment.botId + " is no longer in the catalog; using the global model.",
        metadata: { botId: assignment.botId, modelId: assignment.modelId },
      });
      if (requested === assignment.modelId) {
        var wildcardAgent = plan && plan.agents && plan.agents["*"];
        if (wildcardAgent && typeof wildcardAgent.modelId === "string") requested = wildcardAgent.modelId;
      }
    } else if (assignment) {
      requested = assignment.modelId;
    }
    var route = lookupRoute(plan, requested);
    if (!route) {
      var unknown = { error: { message: "unknown model slug" } };
      record({ status: 400, error: unknown.error.message, responseBody: unknown });
      sendJson(res, 400, unknown);
      return;
    }
    fields.model = route.model.slug;
    fields.providerId = route.provider.id;
    fields.providerName = route.provider.name;
    var oauthCredential = readOpenAIOAuthCredential(route.provider.id);
    var isOpenAIOAuth = oauthCredential !== null;
    var apiType = isOpenAIOAuth ? "responses" : route.provider.apiType === "responses" || route.provider.apiType === "anthropic" ? route.provider.apiType : "chat-completions";
    body.model = route.model.slug;
    if (Array.isArray(body.messages)) {
      body.messages = toOpenAIMessages(body.messages);
      body.messages = await enrichImageReads(body.messages);
      body.messages = await enforceImageBudget(body.messages, {
        extraWireBytes: outboundEnvelopeBytes(body) + WIRE_HEADROOM_BYTES,
      });
      // Normalize every outbound tool call id before the upstream sees it:
      // repair (inside toOpenAIMessages) fills missing ids, sanitize then
      // truncates to <= 64 chars and restricts the charset to [a-zA-Z0-9_-].
      // Must run at the message-assembly point so both host-stream and the
      // direct /v1/chat/completions path are covered.
      body.messages = sanitizeToolCallIds(body.messages);
    }
    applyMaxTokens(body, route.model, apiType);
    applyMaps(body, {
      modelId: route.model.slug,
      baseUrl: route.provider.origin,
      maxMode: false,
      parameters: hopParameters(route.model),
    });
    var outboundBody = apiType === "responses" ? protocolConverters.chatToResponses(body) : apiType === "anthropic" ? protocolConverters.chatToAnthropic(body) : body;
    outboundBody.__openbot_api_type = apiType;
    noteWireBytes(outboundBody);
    fields.requestBody = outboundBody;
    fields.stream = body.stream === true;
    var conversationId = findConversationId(body);
    fields.conversationId = conversationId || fields.conversationId;
    var requestInbound = {
      headers: req.headers || {},
      providerId: route.provider.id,
      providerOrigin: route.provider.origin,
      openaiOAuth: isOpenAIOAuth,
      chatgptAccountId: isOpenAIOAuth ? openAIOAuthAccountId(oauthCredential) : "",
      opencodeSession: route.provider.id === "opencode"
        ? (conversationId ? opencodeSessionId(route.provider.id, conversationId) : nodeCrypto.randomUUID())
        : undefined,
    };
    var key;
    try {
      key = await loadKey(route.provider.id, route.provider);
    } catch (keyErr) {
      var refreshFailure = { error: { message: keyErr.message } };
      record({ status: 503, error: keyErr.message, responseBody: refreshFailure });
      sendJson(res, 503, refreshFailure);
      return;
    }
    if (!key) {
      var noSecret = { error: { message: "no secret for this provider" } };
      record({ status: 503, error: noSecret.error.message, responseBody: noSecret });
      sendJson(res, 503, noSecret);
      return;
    }
    var upstream = resolveUpstreamUrl(route.provider, isOpenAIOAuth, apiType);
    fields.upstreamEndpoint = upstream;
    var out;
    if (body.stream === true) {
      out = await pipeOrBufferUpstream(upstream, outboundBody, key, res, req, apiType === "chat-completions" ? undefined : function (raw) {
        var text = raw.toString("utf8");
        return Buffer.from(apiType === "responses" ? protocolConverters.responsesSseToChat(text) : protocolConverters.anthropicSseToChat(text), "utf8");
      });
      record({
        status: out.status,
        error: retrySuffix(out),
        responseRaw: Buffer.isBuffer(out.raw) ? out.raw.toString("utf8") : String(out.raw),
        attempts: out.attempts,
        attemptCount: out.attemptCount,
        firstTokenMs: out.firstTokenMs,
      });
    } else {
      out = await postUpstream(upstream, outboundBody, key, req, apiType);
      out = convertBufferedResponse(out, apiType);
      record({
        status: out.status,
        error: retrySuffix(out),
        responseRaw: Buffer.isBuffer(out.raw) ? out.raw.toString("utf8") : String(out.raw),
        attempts: out.attempts,
        attemptCount: out.attemptCount,
        firstTokenMs: out.firstTokenMs,
      });
      send(
        res,
        out.status,
        out.raw,
        headerContentType(out.headers) || "application/json",
        retryAfterForwardHeaders(out.headers),
      );
    }
  } catch (err) {
    var failed = { error: { message: "hop failed" } };
    record({
      status: 502,
      error: errorMessageWithRetries(err, "hop failed"),
      responseBody: failed,
    });
    if (!res.headersSent) {
      sendJson(res, 502, failed);
    }
  }
}

function retrySuffix(out) {
  var count = out && typeof out.hopRetries === "number" ? out.hopRetries : 0;
  return count > 0 ? "upstream-retries=" + String(count) : undefined;
}

async function handleHopRequest(req, res) {
  var pathname = pathnameOf(req);
  try {
    if (req.method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, { ok: true, service: "openbot" });
      return true;
    }
    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      await handleCompletions(req, res);
      return true;
    }
    return false;
  } catch (err) {
    if (pathname === "/v1/chat/completions") {
      recordHopSafe({
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        inboundEndpoint: "/v1/chat/completions",
        status: 502,
        error: errorMessageWithRetries(err, "hop failed"),
        responseBody: { error: { message: "hop failed" } },
      });
    }
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: "hop failed" } });
    }
    return true;
  }
}

exports.handleHopRequest = handleHopRequest;
exports.sendJson = sendJson;
exports.readPauseState = readPauseState;
exports.pausePath = pausePath;
exports.pauseBotsPath = pauseBotsPath;
exports.readPauseBotsState = readPauseBotsState;
exports.isBotPaused = isBotPaused;
exports.inboundClientMeta = inboundClientMeta;
exports.detectClientName = detectClientName;
exports.parseClientVersion = parseClientVersion;
exports.findConversationId = findConversationId;
exports.opencodeSessionId = opencodeSessionId;
exports.loadKey = loadKey;
exports.noteFirstContent = noteFirstContent;
exports.lookupRoute = lookupRoute;
exports.completionsUrl = completionsUrl;
exports.resolveUpstreamUrl = resolveUpstreamUrl;
exports.hopParameters = hopParameters;
exports.hopReasoning = hopReasoning;
exports.applyMaxTokens = applyMaxTokens;
exports.outboundEnvelopeBytes = outboundEnvelopeBytes;
exports.looksLikeEventStream = looksLikeEventStream;
exports.UPSTREAM_429_RETRY = UPSTREAM_429_RETRY;
exports.UPSTREAM_5XX_RETRY = UPSTREAM_5XX_RETRY;
exports.parseRetryAfterMs = parseRetryAfterMs;
exports.delayBefore429RetryMs = delayBefore429RetryMs;
exports.delayBefore5xxRetryMs = delayBefore5xxRetryMs;
exports.canRetryUpstream429 = canRetryUpstream429;
exports.canRetryUpstreamStatus = canRetryUpstreamStatus;
exports.canRetryUpstreamError = canRetryUpstreamError;
exports.isRetryableUpstreamStatus = isRetryableUpstreamStatus;
exports.isRetryableUpstreamError = isRetryableUpstreamError;
exports.classifyUpstreamRetry = classifyUpstreamRetry;
exports.retryDelayMs = retryDelayMs;
