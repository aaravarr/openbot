"use strict";

var fs = require("fs");
var http = require("http");
var https = require("https");
var { URL } = require("url");
var path = require("path");
var { toOpenAIMessages } = require("./openai-messages.cjs");
var {
  enrichImageReads,
  enforceImageBudget,
  MAX_REQUEST_WIRE_BYTES,
  WIRE_HEADROOM_BYTES,
} = require("./image-read.cjs");
var { applyOpenBotVersionHeader } = require("./version.cjs");
var requestLog = require("./request-log.cjs");

var TIMEOUT_MS = Number(process.env.OPENBOT_HOP_TIMEOUT || "1800000");
var HIGH_AGENT_MAX_TOKENS = 65536;

/** Policy for retrying upstream HTTP 429 before any client bytes are sent. */
var UPSTREAM_429_RETRY = {
  maxRetries: 3,
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 8000,
  budgetMs: 30000,
};

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
  var exp = UPSTREAM_429_RETRY.baseDelayMs * Math.pow(UPSTREAM_429_RETRY.factor, attemptIndex);
  var capped = Math.min(UPSTREAM_429_RETRY.maxDelayMs, exp);
  var jittered = capped * (0.5 + Math.random() * 0.5);
  return Math.max(0, Math.floor(jittered));
}

function delayBefore429RetryMs(attemptIndex, headers, nowMs, budgetStartedMs) {
  var retryAfter = parseRetryAfterMs(headers, nowMs);
  var delay = retryAfter === null ? exponentialBackoffMs(attemptIndex) : retryAfter;
  var elapsed = Math.max(0, (Number.isFinite(nowMs) ? nowMs : Date.now()) - budgetStartedMs);
  var remaining = UPSTREAM_429_RETRY.budgetMs - elapsed;
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

function canRetryUpstream429(status, attemptIndex, clientRes, budgetStartedMs, nowMs) {
  if (status !== 429) return false;
  if (attemptIndex >= UPSTREAM_429_RETRY.maxRetries) return false;
  if (clientRes && clientRes.headersSent) return false;
  var now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (now - budgetStartedMs >= UPSTREAM_429_RETRY.budgetMs) return false;
  return true;
}

function retryAfterForwardHeaders(upstreamHeaders) {
  var raw = headerValue(upstreamHeaders, "retry-after");
  if (!raw) return undefined;
  return { "Retry-After": raw };
}

function planPath() {
  return process.env.OPENBOT_PLAN || "/home/box/sand-data/openbot-plan.json";
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

function loadKey(providerId) {
  var store = readJson(secretsPath());
  var providers = store && store.providers;
  if (!isRecord(providers) || typeof providers[providerId] !== "string") {
    return "";
  }
  return providers[providerId];
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

function applyMaxTokens(body, model) {
  var cap = Number(model && model.maxOutputTokens);
  if (!Number.isFinite(cap) || cap <= 0) cap = HIGH_AGENT_MAX_TOKENS;
  var requested = Number(body.max_tokens);
  if (!Number.isFinite(requested) || requested <= 0) {
    body.max_tokens = cap;
    return;
  }
  if (requested > cap) body.max_tokens = cap;
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

function openUpstream(urlStr, body, key, inbound) {
  var u = new URL(urlStr);
  var lib = u.protocol === "https:" ? https : http;
  var payload = Buffer.from(JSON.stringify(body), "utf8");
  var wantStream = body && body.stream === true;
  var headers = {
    "Content-Type": "application/json",
    "Content-Length": String(payload.length),
    "Accept": hopAccept(wantStream),
    "Accept-Encoding": "identity",
  };
  if (key) headers.Authorization = "Bearer " + key;
  applyOpenBotVersionHeader(headers);
  var ua = inboundUserAgent(inbound);
  if (ua) headers["User-Agent"] = ua;
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

function postUpstreamOnce(urlStr, body, key, inbound) {
  return new Promise(function (resolve, reject) {
    var req = openUpstream(urlStr, body, key, inbound);
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

async function postUpstream(urlStr, body, key, inbound) {
  var budgetStartedMs = Date.now();
  var attemptIndex = 0;
  while (true) {
    var out = await postUpstreamOnce(urlStr, body, key, inbound);
    if (!canRetryUpstream429(out.status, attemptIndex, null, budgetStartedMs)) {
      return out;
    }
    var nowMs = Date.now();
    var delay = delayBefore429RetryMs(attemptIndex, out.headers, nowMs, budgetStartedMs);
    if (delay === null) return out;
    await sleepMs(delay);
    attemptIndex += 1;
  }
}

function pipeOrBufferUpstreamOnce(urlStr, body, key, clientRes, inbound, activeReq) {
  return new Promise(function (resolve, reject) {
    var req = openUpstream(urlStr, body, key, inbound);
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
      // 429 is decided by status before any client byte. Collect and return
      // without writeHead so the caller can retry while headersSent is false.
      if (status === 429) {
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
      res.on("data", function (c) {
        chunks.push(c);
        if (!clientRes.writableEnded) clientRes.write(c);
      });
      res.on("end", function () {
        if (!clientRes.writableEnded) clientRes.end();
        ok({ status: status || 200, headers: res.headers, raw: Buffer.concat(chunks), forwarded: true });
      });
      res.on("error", fail);
    });
    req.end();
  });
}

async function pipeOrBufferUpstream(urlStr, body, key, clientRes, inbound) {
  var budgetStartedMs = Date.now();
  var attemptIndex = 0;
  var activeReq = { current: null };
  function onClientClose() {
    if (!clientRes.writableEnded && activeReq.current) activeReq.current.destroy();
  }
  clientRes.on("close", onClientClose);
  try {
    while (true) {
      var out = await pipeOrBufferUpstreamOnce(urlStr, body, key, clientRes, inbound, activeReq);
      if (out.forwarded) return out;
      if (!canRetryUpstream429(out.status, attemptIndex, clientRes, budgetStartedMs)) {
        if (!clientRes.headersSent) {
          send(
            clientRes,
            out.status,
            out.raw,
            headerContentType(out.headers) || "application/json",
            retryAfterForwardHeaders(out.headers),
          );
        }
        return out;
      }
      var nowMs = Date.now();
      var delay = delayBefore429RetryMs(attemptIndex, out.headers, nowMs, budgetStartedMs);
      if (delay === null) {
        if (!clientRes.headersSent) {
          send(
            clientRes,
            out.status,
            out.raw,
            headerContentType(out.headers) || "application/json",
            retryAfterForwardHeaders(out.headers),
          );
        }
        return out;
      }
      await sleepMs(delay);
      attemptIndex += 1;
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

function errorMessage(err, fallback) {
  if (err && typeof err.message === "string" && err.message.trim()) return err.message;
  return fallback || "hop failed";
}

async function handleCompletions(req, res) {
  var startedMs = Date.now();
  var startedAt = new Date().toISOString();
  var fields = {
    inboundEndpoint: "/v1/chat/completions",
    stream: false,
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
    });
  }

  try {
    var raw = await readBody(req);
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
    var plan;
    try {
      plan = readJson(planPath());
    } catch (err) {
      var missing = { error: { message: "openbot plan missing; save a provider in the UI" } };
      record({ status: 503, error: missing.error.message, responseBody: missing });
      sendJson(res, 503, missing);
      return;
    }
    var requested = body && body.model;
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
    body.model = route.model.slug;
    if (Array.isArray(body.messages)) {
      body.messages = toOpenAIMessages(body.messages);
      body.messages = await enrichImageReads(body.messages);
      body.messages = await enforceImageBudget(body.messages, {
        extraWireBytes: outboundEnvelopeBytes(body) + WIRE_HEADROOM_BYTES,
      });
    }
    applyMaxTokens(body, route.model);
    applyMaps(body, {
      modelId: route.model.slug,
      baseUrl: route.provider.origin,
      maxMode: false,
      parameters: hopParameters(route.model),
    });
    noteWireBytes(body);
    fields.requestBody = body;
    fields.stream = body.stream === true;
    var key = loadKey(route.provider.id);
    if (!key) {
      var noSecret = { error: { message: "no secret for this provider" } };
      record({ status: 503, error: noSecret.error.message, responseBody: noSecret });
      sendJson(res, 503, noSecret);
      return;
    }
    var upstream = completionsUrl(route.provider.origin);
    fields.upstreamEndpoint = upstream;
    var out;
    if (body.stream === true) {
      out = await pipeOrBufferUpstream(upstream, body, key, res, req);
      record({
        status: out.status,
        responseRaw: Buffer.isBuffer(out.raw) ? out.raw.toString("utf8") : String(out.raw),
      });
    } else {
      out = await postUpstream(upstream, body, key, req);
      record({
        status: out.status,
        responseRaw: Buffer.isBuffer(out.raw) ? out.raw.toString("utf8") : String(out.raw),
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
      error: errorMessage(err, "hop failed"),
      responseBody: failed,
    });
    if (!res.headersSent) {
      sendJson(res, 502, failed);
    }
  }
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
        error: errorMessage(err, "hop failed"),
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
exports.lookupRoute = lookupRoute;
exports.completionsUrl = completionsUrl;
exports.hopParameters = hopParameters;
exports.hopReasoning = hopReasoning;
exports.applyMaxTokens = applyMaxTokens;
exports.outboundEnvelopeBytes = outboundEnvelopeBytes;
exports.looksLikeEventStream = looksLikeEventStream;
exports.UPSTREAM_429_RETRY = UPSTREAM_429_RETRY;
exports.parseRetryAfterMs = parseRetryAfterMs;
exports.delayBefore429RetryMs = delayBefore429RetryMs;
exports.canRetryUpstream429 = canRetryUpstream429;
