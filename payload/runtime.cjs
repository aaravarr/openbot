"use strict";

var fs = require("fs");
var http = require("http");
var https = require("https");
var { URL } = require("url");

var PLAN = process.env.OPENBOT_PLAN || "/home/box/sand-data/openbot-plan.json";
var LOG = process.env.OPENBOT_LOG || "/tmp/openbot-session.log";
var HOP_HOST = process.env.OPENBOT_HOP_HOST || "127.0.0.1";
var HOP_PORT = Number(process.env.OPENBOT_HOP_PORT || "18790");
var HIGH_AGENT_MAX_TOKENS = 65536;

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

function mapToolCalls(openAiCalls) {
  if (!Array.isArray(openAiCalls)) return [];
  var out = [];
  for (var i = 0; i < openAiCalls.length; i++) {
    var raw = openAiCalls[i] || {};
    var fn = raw.function || {};
    var args = {};
    if (typeof fn.arguments === "string") {
      try { args = JSON.parse(fn.arguments || "{}"); } catch (err) { args = {}; }
    } else if (isRecord(fn.arguments)) {
      args = fn.arguments;
    } else if (isRecord(raw.args)) {
      args = raw.args;
    }
    out.push({
      type: "tool-call",
      toolCallId: raw.id || ("call_" + i),
      toolName: fn.name || "",
      args: args,
    });
  }
  return out;
}

function mapFinishReason(reason) {
  if (reason === "tool_calls" || reason === "tool-calls") return "tool-calls";
  if (reason === "length") return "length";
  return "stop";
}

function defaultMaxTokens(requested) {
  if (requested != null && Number.isFinite(requested) && requested > 0) return requested;
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
  for (var i = 0; i < ids.length; i++) {
    if (plan.agents[ids[i]]) return plan.agents[ids[i]];
  }
  if (plan.agents["*"]) return plan.agents["*"];
  return null;
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  var bits = [];
  for (var i = 0; i < content.length; i++) {
    var p = content[i];
    if (p == null) continue;
    if (typeof p === "string") bits.push(p);
    else if (p.type === "text") bits.push(p.text || "");
    else if (p.type === "image") bits.push("[image]");
    else if (p.type === "tool-result") bits.push(typeof p.result === "string" ? p.result : JSON.stringify(p.result || p));
    else bits.push(JSON.stringify(p));
  }
  return bits.join("\n");
}

function toOpenAIMessages(msgs) {
  if (!Array.isArray(msgs)) return [{ role: "user", content: String(msgs || "") }];
  var out = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i] || {};
    var role = m.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") role = "user";
    var row = { role: role, content: contentToText(m.content) };
    if (role === "tool" && m.toolCallId) row.tool_call_id = m.toolCallId;
    if (role === "assistant" && Array.isArray(m.tool_calls)) row.tool_calls = m.tool_calls;
    out.push(row);
  }
  return out.length ? out : [{ role: "user", content: "" }];
}

function postJson(urlStr, body) {
  return new Promise(function (resolve, reject) {
    var u = new URL(urlStr);
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
        "Accept": "application/json",
        "Authorization": "Bearer openbot-runtime",
      },
    }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var raw = Buffer.concat(chunks).toString("utf8");
        var json = null;
        try { json = JSON.parse(raw); } catch (err) { json = null; }
        resolve({ status: res.statusCode, raw: raw, json: json });
      });
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

function hopUrl() {
  return "http://" + HOP_HOST + ":" + String(HOP_PORT) + "/v1/chat/completions";
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
      var msgs = typeof exec.getMessages === "function" ? exec.getMessages() : [];
      var body = {
        model: agent.modelId,
        messages: toOpenAIMessages(msgs),
        stream: false,
        max_tokens: defaultMaxTokens(options2 && options2.maxTokens),
      };
      var openaiTools = unwrapJsonSchemaTools(tools);
      if (openaiTools) body.tools = openaiTools;
      log("stream messages=" + body.messages.length + " tools=" + ((body.tools && body.tools.length) || 0));
      var out = await postJson(hopUrl(), body);
      if (out.status < 200 || out.status >= 300) {
        throw new Error("openbot-runtime: hop HTTP " + out.status + " " + String(out.raw || "").slice(0, 300));
      }
      var choice = out.json && out.json.choices && out.json.choices[0];
      var message = (choice && choice.message) || {};
      var text = typeof message.content === "string" ? message.content : "";
      var calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (message.reasoning_content) {
        yield { type: "reasoning", textDelta: message.reasoning_content };
      }
      if (text) yield { type: "text-delta", textDelta: text };
      var mapped = mapToolCalls(calls);
      for (var i = 0; i < mapped.length; i++) yield mapped[i];
      var u = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      var ru = out.json && out.json.usage;
      if (ru) {
        u.promptTokens = ru.prompt_tokens || 0;
        u.completionTokens = ru.completion_tokens || 0;
        u.totalTokens = ru.total_tokens || 0;
      }
      var finish = mapFinishReason(choice && choice.finish_reason);
      yield { type: "finish", finishReason: finish, usage: u };
      okUsage(u);
      if (!settled.r) {
        settled.r = true;
        resR({
          id: (out.json && out.json.id) || "",
          modelId: agent.modelId,
          timestamp: new Date(),
          messages: [{ role: "assistant", content: [{ type: "text", text: text }] }],
        });
      }
    } catch (err) {
      log("stream error " + (err && err.message));
      failAll(err);
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

function wrapSession(stockFn, args) {
  var arr = Array.prototype.slice.call(args);
  var agent = resolveAgent(arr);
  if (!agent || !agent.modelId) {
    throw new Error("openbot: no model binding for this turn (set a wildcard or matching agent in the control UI)");
  }
  var stock = stockFn.apply(null, arr);
  if (!stock || typeof stock.getSession !== "function") {
    throw new Error("openbot: stock factory did not return a provider with getSession");
  }
  return wrapProvider(stock, agent);
}

module.exports = {
  wrapSession: wrapSession,
  unwrapJsonSchemaTools: unwrapJsonSchemaTools,
  mapToolCalls: mapToolCalls,
  mapFinishReason: mapFinishReason,
  defaultMaxTokens: defaultMaxTokens,
  resolveAgent: resolveAgent,
  HIGH_AGENT_MAX_TOKENS: HIGH_AGENT_MAX_TOKENS,
};
