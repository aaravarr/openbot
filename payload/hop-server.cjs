"use strict";

var fs = require("fs");
var http = require("http");
var https = require("https");
var { URL } = require("url");
var path = require("path");

var HOST = process.env.OPENBOT_HOP_HOST || "127.0.0.1";
var PORT = Number(process.env.OPENBOT_HOP_PORT || "18790");
var PLAN = process.env.OPENBOT_PLAN || "/home/box/sand-data/openbot-plan.json";
var SECRETS = process.env.OPENBOT_SECRETS || "/home/box/sand-data/secrets.json";
var MAPS = process.env.OPENBOT_MAPS || path.join(__dirname, "provider-maps.cjs");
var PID_FILE = process.env.OPENBOT_HOP_PID;
var TIMEOUT_MS = Number(process.env.OPENBOT_HOP_TIMEOUT || "1800000");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  var store = readJson(SECRETS);
  var providers = store && store.providers;
  if (!isRecord(providers) || typeof providers[providerId] !== "string") {
    return "";
  }
  return providers[providerId];
}

function applyMaps(body, ctx) {
  var maps;
  try {
    delete require.cache[require.resolve(MAPS)];
    maps = require(MAPS);
  } catch (err) {
    return;
  }
  if (maps && typeof maps.applyProviderReasoningControls === "function") {
    maps.applyProviderReasoningControls(body, ctx);
  }
}

function postUpstream(urlStr, body, key) {
  return new Promise(function (resolve, reject) {
    var u = new URL(urlStr);
    var lib = u.protocol === "https:" ? https : http;
    var payload = Buffer.from(JSON.stringify(body), "utf8");
    var headers = {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
      "Accept": "application/json",
      "Accept-Encoding": "identity",
    };
    if (key) headers.Authorization = "Bearer " + key;
    var req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers: headers,
    }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({ status: res.statusCode || 502, headers: res.headers, raw: Buffer.concat(chunks) });
      });
    });
    req.setTimeout(TIMEOUT_MS, function () {
      req.destroy();
      reject(new Error("openbot-hop: upstream timeout"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function send(res, status, payload, contentType) {
  var body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  res.writeHead(status, {
    "Content-Type": contentType || "application/json",
    "Content-Length": String(body.length),
  });
  res.end(body);
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

var server = http.createServer(async function (req, res) {
  try {
    if (req.url === "/healthz") {
      send(res, 200, JSON.stringify({ ok: true, service: "openbot-hop", port: PORT }));
      return;
    }
    if (req.method !== "POST") {
      send(res, 404, JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    var raw = await readBody(req);
    var body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch (err) {
      send(res, 400, JSON.stringify({ error: { message: "invalid json" } }));
      return;
    }
    var plan;
    try {
      plan = readJson(PLAN);
    } catch (err) {
      send(res, 503, JSON.stringify({ error: { message: "openbot plan missing; save a provider in the UI" } }));
      return;
    }
    var requested = body && body.model;
    var route = lookupRoute(plan, requested);
    if (!route) {
      send(res, 400, JSON.stringify({ error: { message: "unknown model slug" } }));
      return;
    }
    body.model = route.model.slug;
    applyMaps(body, {
      modelId: route.model.slug,
      baseUrl: route.provider.origin,
      maxMode: false,
      parameters: route.model.parameters || [],
    });
    var key = loadKey(route.provider.id);
    if (!key) {
      send(res, 503, JSON.stringify({ error: { message: "no secret for this provider" } }));
      return;
    }
    var upstream = completionsUrl(route.provider.origin);
    var out = await postUpstream(upstream, body, key);
    send(res, out.status, out.raw, (out.headers && (out.headers["content-type"] || out.headers["Content-Type"])) || "application/json");
  } catch (err) {
    send(res, 502, JSON.stringify({ error: { message: "hop failed" } }));
  }
});

server.listen(PORT, HOST, function () {
  if (PID_FILE) {
    try {
      fs.writeFileSync(PID_FILE, String(process.pid) + "\n");
    } catch (err) {
      /* ignore */
    }
  }
  process.stdout.write("openbot-hop listening on " + HOST + ":" + String(PORT) + "\n");
});
