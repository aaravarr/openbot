"use strict";

var fs = require("fs");
var http = require("http");
var https = require("https");
var path = require("path");
var { URL } = require("url");
var { toOpenAIMessages } = require("./openai-messages.cjs");
var openaiStream = require("./openai-stream.cjs");
var requestLog = require("./request-log.cjs");

function sandDir() {
  if (process.env.OPENBOT_SAND_DATA) return process.env.OPENBOT_SAND_DATA;
  if (process.env.OPENBOT_PLAN) return path.dirname(process.env.OPENBOT_PLAN);
  return "/home/box/sand-data";
}

var PLAN = process.env.OPENBOT_PLAN || path.join(sandDir(), "openbot-plan.json");
var MODE = process.env.OPENBOT_MODE || path.join(sandDir(), "openbot-mode");
var LOG = process.env.OPENBOT_LOG || "/tmp/openbot-session.log";
var HOP_HOST = process.env.OPENBOT_HOP_HOST || "127.0.0.1";
var HOP_PORT = Number(process.env.OPENBOT_HOP_PORT || "9280");
var HIGH_AGENT_MAX_TOKENS = 65536;
var MAX_SAFE_STRING = 32768;

var mapToolCalls = openaiStream.mapToolCalls;
var mapFinishReason = openaiStream.mapFinishReason;
var iterateOpenAiResponse = openaiStream.iterateOpenAiResponse;
var findVoiceTool = openaiStream.findVoiceTool;

function log(line) {
  try {
    fs.appendFileSync(LOG, new Date().toISOString() + " " + line + "\n");
  } catch (err) {
    /* ignore */
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonSafe(value, depth, seen) {
  if (depth > 10) return "[max-depth]";
  if (value === null || value === undefined) return value;
  var t = typeof value;
  if (t === "string") {
    if (value.length > MAX_SAFE_STRING) {
      return { _truncated: true, _originalChars: value.length, preview: value.slice(0, 4000) };
    }
    return value;
  }
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t === "function" || t === "symbol") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return { _bytes: value.length };
  }
  if (t === "object") {
    if (typeof value.then === "function") return "[promise]";
    var bag = seen || new WeakSet();
    if (bag.has(value)) return "[circular]";
    bag.add(value);
    if (Array.isArray(value)) {
      var rows = [];
      var n = Math.min(value.length, 400);
      for (var i = 0; i < n; i++) {
        var item = jsonSafe(value[i], depth + 1, bag);
        rows.push(item === undefined ? null : item);
      }
      if (value.length > n) rows.push({ _truncated: true, _omitted: value.length - n });
      return rows;
    }
    var out = {};
    var keys = Object.keys(value);
    var kmax = Math.min(keys.length, 80);
    for (var k = 0; k < kmax; k++) {
      var key = keys[k];
      if (/^(authorization|api[-_]?key|x-api-key|cookie|password|secret|token)$/i.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      var next = jsonSafe(value[key], depth + 1, bag);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return String(value);
}

function recordHostStream(entry) {
  try {
    requestLog.recordHop(entry);
  } catch (err) {
    /* never throw into the chat path */
  }
}

function asJsonSchema(value) {
  if (!isRecord(value)) {
    return { type: "object", properties: {} };
  }
  if (isRecord(value.jsonSchema)) {
    return asJsonSchema(value.jsonSchema);
  }
  var properties = isRecord(value.properties) ? value.properties : {};
  var schema = { type: "object", properties: properties };
  if (Array.isArray(value.required)) {
    schema.required = value.required.filter(function (item) { return typeof item === "string"; });
  }
  return schema;
}

function unwrapJsonSchemaTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  var out = [];
  for (var i = 0; i < tools.length; i++) {
    var tool = tools[i];
    if (!tool || tool.type === "provider-defined") continue;
    var fn = tool.function || tool;
    var name = tool.name || fn.name;
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name: name,
        description: tool.description || fn.description || "",
        parameters: asJsonSchema(tool.parameters || fn.parameters),
      },
    });
  }
  return out.length ? out : undefined;
}

function defaultMaxTokens(requested, cap) {
  var limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : HIGH_AGENT_MAX_TOKENS;
  if (requested != null && Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.floor(requested), limit);
  }
  return limit;
}

function lookupMaxOutput(plan, agent) {
  var models = plan && plan.catalog && plan.catalog.models;
  if (!Array.isArray(models) || !agent) return HIGH_AGENT_MAX_TOKENS;
  for (var i = 0; i < models.length; i++) {
    var row = models[i];
    if (!row) continue;
    if (row.slug === agent.modelId || row.id === agent.modelId) {
      var n = Number(row.maxOutputTokens);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return HIGH_AGENT_MAX_TOKENS;
}

function collectIds(args) {
  var ids = [];
  var seen = Object.create(null);
  function add(s) {
    if (typeof s !== "string") return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return;
    var k = s.toLowerCase();
    if (seen[k]) return;
    seen[k] = true;
    ids.push(s);
  }
  function walk(v, depth) {
    if (depth > 5 || v == null) return;
    if (typeof v === "string") { add(v); return; }
    if (typeof v !== "object") return;
    var keys = ["conversationId", "agentId", "id", "provenanceAgentId", "botId"];
    for (var i = 0; i < keys.length; i++) {
      if (v[keys[i]] != null) walk(v[keys[i]], depth + 1);
    }
  }
  for (var i = 0; i < args.length; i++) walk(args[i], 0);
  return ids;
}

function loadPlan() {
  var raw = fs.readFileSync(PLAN, "utf8");
  return JSON.parse(raw);
}

function readMode() {
  try {
    var text = fs.readFileSync(MODE, "utf8").trim();
    if (text === "custom" || text === "official") return text;
  } catch (err) {
    /* fall through */
  }
  try {
    var plan = loadPlan();
    if (plan && plan.kind === "custom") return "custom";
  } catch (err) {
    /* fall through */
  }
  return "official";
}

function isCustomMode() {
  return readMode() === "custom";
}

function resolveAgent(args) {
  var plan;
  try {
    plan = loadPlan();
  } catch (err) {
    log("plan unreadable: " + err.message);
    return null;
  }
  if (!plan || plan.kind !== "custom" || !plan.agents) return null;
  var ids = collectIds(args);
  var found = null;
  for (var i = 0; i < ids.length; i++) {
    if (plan.agents[ids[i]]) {
      found = plan.agents[ids[i]];
      break;
    }
  }
  if (!found && plan.agents["*"]) found = plan.agents["*"];
  if (!found || !found.modelId) return null;
  return {
    modelId: found.modelId,
    providerId: found.providerId,
    maxOutputTokens: lookupMaxOutput(plan, found),
  };
}

function hopUrl() {
  return "http://" + HOP_HOST + ":" + String(HOP_PORT) + "/v1/chat/completions";
}

function readAll(res) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    res.on("data", function (c) { chunks.push(c); });
    res.on("end", function () {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    res.on("error", reject);
  });
}

function hopRequest(body) {
  return new Promise(function (resolve, reject) {
    var u = new URL(hopUrl());
    var lib = u.protocol === "https:" ? https : http;
    var payload = Buffer.from(JSON.stringify(body), "utf8");
    var req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
        "Accept": "text/event-stream, application/json",
        "Authorization": "Bearer openbot-runtime",
      },
    }, function (res) {
      resolve(res);
    });
    req.setTimeout(1800000, function () {
      req.destroy();
      reject(new Error("openbot-runtime: hop timeout"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function swallow(p) {
  Promise.resolve(p).catch(function () {});
  return p;
}

function hopFullStream(exec, agent, ctx, invocationId, tools, options2) {
  var settled = { u: false, e: false, m: false, i: false, r: false };
  var resU, rejU, resE, rejE, resM, rejM, resI, rejI, resR, rejR;
  var usage = swallow(new Promise(function (res, rej) { resU = res; rejU = rej; }));
  var extendedUsage = swallow(new Promise(function (res, rej) { resE = res; rejE = rej; }));
  var providerMetadata = swallow(new Promise(function (res, rej) { resM = res; rejM = rej; }));
  var inv = swallow(new Promise(function (res, rej) { resI = res; rejI = rej; }));
  var response = swallow(new Promise(function (res, rej) { resR = res; rejR = rej; }));
  var startedMs = Date.now();
  var startedAt = new Date().toISOString();
  var hostParts = [];
  var hostMsgs = [];
  var recordedHost = false;
  var settledResponse;

  function recordCustomHost(extra) {
    if (recordedHost) return;
    recordedHost = true;
    extra = extra || {};
    recordHostStream({
      channel: "custom-host",
      inboundEndpoint: "host-stream",
      startedAt: startedAt,
      completedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedMs,
      stream: true,
      model: agent.modelId,
      providerId: agent.providerId,
      status: extra.status,
      error: extra.error,
      usage: extra.usage,
      requestBody: {
        messages: jsonSafe(hostMsgs, 0),
        tools: jsonSafe(tools, 0),
        options: jsonSafe(options2 ? { maxTokens: options2.maxTokens } : undefined, 0),
      },
      responseBody: {
        parts: hostParts,
        response: jsonSafe(settledResponse, 0),
      },
    });
  }

  function failAll(err) {
    if (!settled.u) { settled.u = true; rejU(err); }
    if (!settled.e) { settled.e = true; rejE(err); }
    if (!settled.m) { settled.m = true; rejM(err); }
    if (!settled.i) { settled.i = true; rejI(err); }
    if (!settled.r) { settled.r = true; rejR(err); }
  }
  function okUsage(u) {
    if (!settled.u) { settled.u = true; resU(u); }
    if (!settled.e) {
      settled.e = true;
      resE({
        inputTokens: u.promptTokens || 0,
        outputTokens: u.completionTokens || 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        maxTokens: 0,
      });
    }
    if (!settled.m) { settled.m = true; resM(undefined); }
    if (!settled.i) { settled.i = true; resI(invocationId || "openbot"); }
  }

  var fullStream = (async function* () {
    try {
      hostMsgs = typeof exec.getMessages === "function" ? exec.getMessages() : [];
      var body = {
        model: agent.modelId,
        messages: toOpenAIMessages(hostMsgs),
        stream: true,
        max_tokens: defaultMaxTokens(options2 && options2.maxTokens, agent.maxOutputTokens),
      };
      var openaiTools = unwrapJsonSchemaTools(tools);
      if (openaiTools) body.tools = openaiTools;
      var voiceTool = findVoiceTool(tools) || findVoiceTool(openaiTools);
      log("stream messages=" + body.messages.length + " tools=" + ((body.tools && body.tools.length) || 0));
      var res = await hopRequest(body);
      var status = res.statusCode || 0;
      if (status < 200 || status >= 300) {
        var raw = await readAll(res);
        throw new Error("openbot-runtime: hop HTTP " + status + " " + String(raw || "").slice(0, 300));
      }
      var text = "";
      var u = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      var hopId = "";
      for await (var part of iterateOpenAiResponse(res, voiceTool)) {
        if (part && part.type === "text-delta" && part.textDelta) {
          text += part.textDelta;
        }
        if (part && part.type === "finish") {
          if (part.usage) u = part.usage;
          if (part.id) hopId = part.id;
        }
        try {
          hostParts.push(jsonSafe(part, 0));
        } catch (err) {
          /* ignore */
        }
        yield part;
      }
      okUsage(u);
      settledResponse = {
        id: hopId,
        modelId: agent.modelId,
        timestamp: new Date(),
        messages: [{ role: "assistant", content: [{ type: "text", text: text }] }],
      };
      if (!settled.r) {
        settled.r = true;
        resR(settledResponse);
      }
      recordCustomHost({ status: 200, usage: u });
    } catch (err) {
      log("stream error " + (err && err.message));
      failAll(err);
      recordCustomHost({
        status: 502,
        error: err && err.message ? String(err.message) : "hop failed",
      });
      yield { type: "error", error: err };
      throw err;
    }
  })();

  return {
    fullStream: fullStream,
    usage: usage,
    extendedUsage: extendedUsage,
    providerMetadata: providerMetadata,
    invocationId: inv,
    response: response,
  };
}

function wrapExecutor(exec, agent) {
  return new Proxy(exec, {
    get: function (target, prop, receiver) {
      if (prop === "stream") {
        return function (ctx, invocationId, tools, options2) {
          return hopFullStream(target, agent, ctx, invocationId, tools, options2);
        };
      }
      var val = Reflect.get(target, prop, receiver);
      if (typeof val === "function") return val.bind(target);
      return val;
    },
  });
}

function wrapPromptSession(inner, agent, middleware) {
  return {
    getExecutor: function (state) {
      var raw = inner.getExecutor(state);
      var hopExec = wrapExecutor(raw, agent);
      return middleware ? middleware(hopExec) : hopExec;
    },
    getModelId: function () {
      return agent.modelId;
    },
  };
}

function wrapProvider(stockProvider, agent) {
  return {
    getSession: function (middleware) {
      var inner = stockProvider.getSession(undefined);
      return wrapPromptSession(inner, agent, middleware);
    },
    getProviderName: function () {
      return typeof stockProvider.getProviderName === "function" ? stockProvider.getProviderName() : "proto";
    },
    getModelId: function () {
      return agent.modelId;
    },
    getThinkingDetails: function () {
      return typeof stockProvider.getThinkingDetails === "function" ? stockProvider.getThinkingDetails() : undefined;
    },
  };
}

function callStock(stockFn, args) {
  var stock = stockFn.apply(null, args);
  if (!stock || typeof stock.getSession !== "function") {
    throw new Error("openbot: stock factory did not return a provider with getSession");
  }
  return stock;
}

function tapMeta(stock, args) {
  var modelId = typeof stock.getModelId === "function" ? stock.getModelId() : undefined;
  var providerName = typeof stock.getProviderName === "function" ? stock.getProviderName() : "proto";
  return {
    modelId: typeof modelId === "string" && modelId ? modelId : "official",
    providerName: typeof providerName === "string" && providerName ? providerName : "proto",
    requestedModel: jsonSafe(args[1], 0),
    modelConfig: jsonSafe(args[2], 0),
    inferenceReason: jsonSafe(args[3], 0),
  };
}

function tapStreamResult(result, ctx) {
  if (!result || typeof result !== "object") return result;
  var original = result.fullStream;
  if (!original || typeof original[Symbol.asyncIterator] !== "function") return result;
  var parts = [];
  var fullStream = (async function* () {
    var err;
    try {
      for await (var part of original) {
        try {
          parts.push(jsonSafe(part, 0));
        } catch (ignore) {
          /* ignore */
        }
        yield part;
      }
    } catch (e) {
      err = e;
      throw e;
    } finally {
      var responseP = result.response;
      var usageP = result.usage;
      swallow(Promise.allSettled([
        Promise.resolve(responseP),
        Promise.resolve(usageP),
      ]).then(function (rows) {
        var responseVal = rows[0] && rows[0].status === "fulfilled" ? rows[0].value : undefined;
        var usageVal = rows[1] && rows[1].status === "fulfilled" ? rows[1].value : undefined;
        recordHostStream({
          channel: "official",
          inboundEndpoint: "host-stream",
          startedAt: ctx.startedAt,
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - ctx.startedMs,
          stream: true,
          model: ctx.meta.modelId,
          providerName: ctx.meta.providerName,
          status: err ? 500 : 200,
          error: err && err.message ? String(err.message) : undefined,
          usage: usageVal,
          requestBody: {
            messages: jsonSafe(ctx.messages, 0),
            tools: jsonSafe(ctx.tools, 0),
            options: jsonSafe(ctx.options ? { maxTokens: ctx.options.maxTokens } : undefined, 0),
            requestedModel: ctx.meta.requestedModel,
            modelConfig: ctx.meta.modelConfig,
            inferenceReason: ctx.meta.inferenceReason,
            invocationId: jsonSafe(ctx.invocationId, 0),
          },
          responseBody: {
            parts: parts,
            response: jsonSafe(responseVal, 0),
          },
        });
      }));
    }
  })();
  var out = {};
  var keys = Object.keys(result);
  for (var i = 0; i < keys.length; i++) {
    out[keys[i]] = result[keys[i]];
  }
  out.fullStream = fullStream;
  return out;
}

function tapExecutor(exec, meta) {
  return new Proxy(exec, {
    get: function (target, prop, receiver) {
      if (prop === "stream") {
        return function (ctx, invocationId, tools, options2) {
          var startedMs = Date.now();
          var startedAt = new Date().toISOString();
          var messages = typeof target.getMessages === "function" ? target.getMessages() : [];
          var result = target.stream(ctx, invocationId, tools, options2);
          return tapStreamResult(result, {
            startedMs: startedMs,
            startedAt: startedAt,
            meta: meta,
            messages: messages,
            tools: tools,
            options: options2,
            invocationId: invocationId,
          });
        };
      }
      var val = Reflect.get(target, prop, receiver);
      if (typeof val === "function") return val.bind(target);
      return val;
    },
  });
}

function tapProvider(stock, meta) {
  return {
    getSession: function (middleware) {
      var inner = stock.getSession(middleware);
      return {
        getExecutor: function (state) {
          return tapExecutor(inner.getExecutor(state), meta);
        },
        getModelId: function () {
          return typeof inner.getModelId === "function" ? inner.getModelId() : meta.modelId;
        },
      };
    },
    getProviderName: function () {
      return meta.providerName;
    },
    getModelId: function () {
      return meta.modelId;
    },
    getThinkingDetails: function () {
      return typeof stock.getThinkingDetails === "function" ? stock.getThinkingDetails() : undefined;
    },
  };
}

function tapSession(stockFn, args) {
  var arr = Array.prototype.slice.call(args);
  var stock = callStock(stockFn, arr);
  return tapProvider(stock, tapMeta(stock, arr));
}

function wrapHopSession(stockFn, args) {
  var arr = Array.prototype.slice.call(args);
  var agent = resolveAgent(arr);
  if (!agent || !agent.modelId) {
    throw new Error("openbot: no model binding for this turn (set a wildcard or matching agent in the control UI)");
  }
  return wrapProvider(callStock(stockFn, arr), agent);
}

function wrapSession(stockFn, args) {
  if (!isCustomMode()) {
    return tapSession(stockFn, args);
  }
  return wrapHopSession(stockFn, args);
}

function attachSession(stockFn, args) {
  if (isCustomMode()) {
    return wrapHopSession(stockFn, args);
  }
  return tapSession(stockFn, args);
}

module.exports = {
  wrapSession: wrapSession,
  attachSession: attachSession,
  tapSession: tapSession,
  isCustomMode: isCustomMode,
  jsonSafe: jsonSafe,
  unwrapJsonSchemaTools: unwrapJsonSchemaTools,
  mapToolCalls: mapToolCalls,
  mapFinishReason: mapFinishReason,
  defaultMaxTokens: defaultMaxTokens,
  resolveAgent: resolveAgent,
  lookupMaxOutput: lookupMaxOutput,
  toOpenAIMessages: toOpenAIMessages,
  hopFullStream: hopFullStream,
  HIGH_AGENT_MAX_TOKENS: HIGH_AGENT_MAX_TOKENS,
};
