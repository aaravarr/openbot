"use strict";

var fs = require("fs");
var http = require("http");
var https = require("https");
var net = require("net");
var childProcess = require("child_process");
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

function pausePath() {
  if (process.env.OPENBOT_PAUSE) return process.env.OPENBOT_PAUSE;
  return path.join(sandDir(), "openbot-pause.json");
}

// Global gateway pause flag. Read synchronously on every session/stream
// entry so flipping the switch takes effect without a host bounce.
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

function assertNotPaused() {
  if (readPauseState()) {
    throw new Error("openbot-runtime: gateway paused");
  }
}

var PLAN = process.env.OPENBOT_PLAN || path.join(sandDir(), "openbot-plan.json");
var MODE = process.env.OPENBOT_MODE || path.join(sandDir(), "openbot-mode");
var LOG = process.env.OPENBOT_LOG || "/tmp/openbot-session.log";
var HOP_HOST = process.env.OPENBOT_HOP_HOST || "127.0.0.1";
var HOP_PORT = Number(process.env.OPENBOT_HOP_PORT || "9280");
var HIGH_AGENT_MAX_TOKENS = 65536;
var MAX_SAFE_STRING = 32768;

// Global safety ceiling for outbound max_tokens (mirrors
// MAX_OUTPUT_TOKENS_CEILING in src/domain/types.ts; payload is
// zero-dependency CJS injected into the host, so the constant is duplicated
// rather than imported). A catalog row above this is data corruption (e.g.
// the 943718 seen on meta/muse-spark-1.3-contributor in 2026-09: a
// context-window figure in a max-completion field), never a real model
// limit, and must never reach the wire: providers reject it with 400.
var MAX_OUTPUT_TOKENS_CEILING = 131072;
var HOP_RETRY = {
  maxRetries: 3,
  baseDelayMs: 1000,
  factor: 3,
};

var mapToolCalls = openaiStream.mapToolCalls;
var mapFinishReason = openaiStream.mapFinishReason;
var iterateOpenAiResponse = openaiStream.iterateOpenAiResponse;
var findVoiceTool = openaiStream.findVoiceTool;
var assistantMessageContent = openaiStream.assistantMessageContent;

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
  // The cap itself is clamped first: a poisoned plan row (e.g. 943718)
  // must not become the limit. Unreliable caps fall back to the default.
  var limit = HIGH_AGENT_MAX_TOKENS;
  if (Number.isFinite(cap) && cap > 0) {
    limit = Math.min(Math.floor(cap), MAX_OUTPUT_TOKENS_CEILING);
  }
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
      // Clamp at the source: a poisoned row (e.g. 943718) falls back to the
      // default instead of flowing into max_tokens and sailing through the
      // hop-side self-comparison.
      if (Number.isFinite(n) && n > 0 && n <= MAX_OUTPUT_TOKENS_CEILING) return Math.floor(n);
      return HIGH_AGENT_MAX_TOKENS;
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

function hopRetryDelayMs(attemptIndex) {
  var exp = HOP_RETRY.baseDelayMs * Math.pow(HOP_RETRY.factor, attemptIndex);
  return Math.min(5000, Math.max(0, exp));
}

function isRetryableHopStatus(status) {
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  // Cloudflare edge errors pass through hop unchanged; 524 (origin timeout)
  // is the common one and is worth a full replay. 521/525 excluded: those are
  // config-level failures an immediate replay will not fix.
  return status === 520 || status === 522 || status === 523 || status === 524 || status === 526 || status === 527;
}

function isRetryableHopError(err) {
  if (!err) return false;
  var code = typeof err.code === "string" ? err.code : "";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") return true;
  if (code === "ECONNABORTED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return true;
  var msg = typeof err.message === "string" ? err.message : "";
  return msg.indexOf("socket hang up") !== -1 || msg.indexOf("ECONNRESET") !== -1 || msg.indexOf("ETIMEDOUT") !== -1;
}

// ---- In-request hop self-heal (gateway-owned; the guard daemon stays the backstop). ----
//
// Budgets (worst-case added latency per request, on top of upstream time):
//   retry delays ............ 1s + 3s = ~4s   (HOP_RETRY, unchanged)
//   port probe .............. 0.25s           (mirrors procs.portOpen)
//   live-pid grace .......... 3s              (a starting hop may just be slow)
//   spawn + port wait ....... 15s cap         (cold node boot is ~0.5-2s)
//   per-request retry budget  30s from the first failure (HOP_HEAL.retryBudgetMs)
// Steady-state cost is one ~ms TCP probe per retry; spawning happens only
// when the port is actually closed, and concurrent healers share one
// in-flight attempt plus a pidfile-mtime throttle against other processes.
var HOP_HEAL = {
  probeTimeoutMs: 250,
  pollMs: 100,
  startupGraceMs: 3000,
  spawnWaitMs: 15000,
  spawnThrottleMs: 10000,
  shortWaitMs: 2000,
  retryBudgetMs: 30000,
};

var healInFlight = null;
var lastSpawnAt = 0;
var lastSpawnPid = 0;

function hopHealTarget(overrides) {
  var o = overrides && typeof overrides === "object" ? overrides : {};
  var entry = typeof o.entry === "string" && o.entry
    ? o.entry
    : process.env.OPENBOT_HOP_ENTRY || path.join(__dirname, "hop-server.cjs");
  var pidFile = typeof o.pidFile === "string" && o.pidFile
    ? o.pidFile
    : process.env.OPENBOT_HOP_PID || path.join(sandDir(), "openbot-hop.pid");
  var logFile = typeof o.logFile === "string" && o.logFile
    ? o.logFile
    : process.env.OPENBOT_HOP_LOG || path.join(sandDir(), "openbot-hop.log");
  return {
    host: typeof o.host === "string" && o.host ? o.host : HOP_HOST,
    port: Number.isFinite(Number(o.port)) && Number(o.port) > 0 ? Number(o.port) : HOP_PORT,
    entry: entry,
    pidFile: pidFile,
    logFile: logFile,
  };
}

function hopPortOpen(host, port, timeoutMs) {
  return new Promise(function (resolve) {
    var done = false;
    var socket;
    try {
      socket = net.connect({ host: host, port: port });
    } catch (err) {
      resolve(false);
      return;
    }
    function finish(open) {
      if (done) return;
      done = true;
      try {
        socket.removeAllListeners();
      } catch (err) {
        /* ignore */
      }
      try {
        socket.destroy();
      } catch (err) {
        /* ignore */
      }
      resolve(open);
    }
    socket.setTimeout(timeoutMs || HOP_HEAL.probeTimeoutMs);
    socket.once("connect", function () {
      finish(true);
    });
    socket.once("timeout", function () {
      finish(false);
    });
    socket.once("error", function () {
      finish(false);
    });
  });
}

function readHopPid(pidFile) {
  try {
    var pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (err) {
    return undefined;
  }
}

function hopPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

function hopPidFileAgeMs(pidFile) {
  try {
    return Date.now() - fs.statSync(pidFile).mtimeMs;
  } catch (err) {
    return undefined;
  }
}

// Poll the port until it opens or the deadline passes. When a spawned child
// handle is given, give up early once it has exited: a dead child will never
// open the port, and waiting out the full window would only stall the retry.
function waitHopPort(host, port, waitMs, child) {
  var deadline = Date.now() + Math.max(0, waitMs);
  function poll(resolve) {
    if (child && child.exitCode !== null && child.exitCode !== undefined) {
      resolve(false);
      return;
    }
    hopPortOpen(host, port).then(function (open) {
      if (open || Date.now() >= deadline) {
        resolve(open);
        return;
      }
      setTimeout(function () {
        poll(resolve);
      }, HOP_HEAL.pollMs);
    });
  }
  return new Promise(poll);
}

// Mirror of src/supervisor procs.start: detached spawn, output appended to
// the hop log, pidfile written (hop-server rewrites the same file on listen,
// so both writers converge). Never throws: failures surface as null and the
// caller falls back to plain retries.
function spawnHopServer(target) {
  try {
    fs.mkdirSync(path.dirname(target.pidFile), { recursive: true });
    fs.mkdirSync(path.dirname(target.logFile), { recursive: true });
  } catch (err) {
    /* best-effort */
  }
  var logFd;
  try {
    logFd = fs.openSync(target.logFile, "a");
  } catch (err) {
    return null;
  }
  var child;
  try {
    child = childProcess.spawn(process.execPath, [target.entry], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: Object.assign({}, process.env, {
        OPENBOT_HOP_HOST: target.host,
        OPENBOT_HOP_PORT: String(target.port),
        OPENBOT_HOP_PID: target.pidFile,
      }),
    });
  } catch (err) {
    try {
      fs.closeSync(logFd);
    } catch (closeErr) {
      /* ignore */
    }
    return null;
  }
  try {
    fs.closeSync(logFd);
  } catch (err) {
    /* ignore */
  }
  // A failed spawn (bad entry path, EACCES, ...) arrives as an async error
  // event: swallow it here so it can never take down the host process. The
  // exit-code check in waitHopPort reports the failure to the caller.
  child.on("error", function () {
    /* reported via exitCode polling */
  });
  if (child.pid === undefined) return null;
  try {
    child.unref();
  } catch (err) {
    /* ignore */
  }
  try {
    fs.writeFileSync(target.pidFile, String(child.pid) + "\n", { encoding: "utf8", mode: 0o644 });
  } catch (err) {
    /* hop-server rewrites it on listen; ours is best-effort */
  }
  lastSpawnAt = Date.now();
  lastSpawnPid = child.pid;
  return child;
}

async function doHealUp(target, allowSpawn) {
  if (await hopPortOpen(target.host, target.port)) return { ok: true, action: "already-up" };
  if (!allowSpawn) {
    // Post-heal retries: confirm only, never spawn (bounded extra latency).
    if (await waitHopPort(target.host, target.port, HOP_HEAL.shortWaitMs, null)) {
      return { ok: true, action: "waited" };
    }
    return { ok: false, action: "still-down" };
  }
  var pid = readHopPid(target.pidFile);
  var ownerAlive = pid !== undefined && hopPidAlive(pid);
  var age = hopPidFileAgeMs(target.pidFile);
  var freshPidfile = age !== undefined && age < HOP_HEAL.spawnThrottleMs;
  // Our own recent spawn counts only while that child is still alive: a
  // dead child will never open the port, so throttling on it would stall
  // every later retry behind a full wait window for nothing.
  var recentSpawn = Date.now() - lastSpawnAt < HOP_HEAL.spawnThrottleMs &&
    lastSpawnPid > 0 &&
    hopPidAlive(lastSpawnPid);
  if (!ownerAlive && !freshPidfile && !recentSpawn) {
    // Nobody owns the address and nobody just spawned: safe to launch.
    // A live-but-portless owner gets one grace window inside the wait
    // below only when the throttle says someone is actively starting.
    var child = spawnHopServer(target);
    if (child) {
      log("hop heal: spawned hop-server pid=" + child.pid + " for " + target.host + ":" + String(target.port));
      if (await waitHopPort(target.host, target.port, HOP_HEAL.spawnWaitMs, child)) {
        return { ok: true, action: "spawned", pid: child.pid };
      }
      log("hop heal: spawned pid=" + child.pid + " never opened " + String(target.port));
    } else {
      log("hop heal: spawn failed for " + target.host + ":" + String(target.port));
    }
    return { ok: false, action: "spawn-failed" };
  }
  if (ownerAlive) {
    // The pidfile owner is alive but portless (still starting or wedged):
    // a short grace first, then the full wait below covers a slow boot.
    if (await waitHopPort(target.host, target.port, HOP_HEAL.startupGraceMs, null)) {
      return { ok: true, action: "waited" };
    }
  }
  // A live owner, a fresh pidfile from another process, or our own live
  // recent spawn: wait for the port instead of stampeding a second server
  // onto the same address.
  if (await waitHopPort(target.host, target.port, HOP_HEAL.spawnWaitMs, null)) {
    return { ok: true, action: "waited" };
  }
  return { ok: false, action: ownerAlive ? "owner-wedged" : "spawn-throttled" };
}

// In-request entry point. Resolves {ok, action}; never throws and never
// touches the chat path on failure — callers fall back to plain retries.
// Concurrent healers in this process share one in-flight attempt; the port
// is re-checked under that mutex so a winner's hop is reused, not respawned.
function ensureHopUp(overrides, allowSpawn) {
  var target = hopHealTarget(overrides);
  if (allowSpawn === undefined) allowSpawn = true;
  return hopPortOpen(target.host, target.port).then(function (open) {
    if (open) return { ok: true, action: "already-up" };
    if (healInFlight) return healInFlight;
    healInFlight = doHealUp(target, allowSpawn);
    return healInFlight.then(
      function (result) {
        healInFlight = null;
        return result;
      },
      function () {
        healInFlight = null;
        return { ok: false, action: "error" };
      },
    );
  });
}

// Test seam: drop any shared heal attempt and spawn-throttle timestamp.
function resetHopHealState() {
  healInFlight = null;
  lastSpawnAt = 0;
  lastSpawnPid = 0;
}

/** Bounded retry around hopRequest. Callers must only call this before any
 * byte of the response has been consumed: the promise resolves with the
 * first response that has a usable (2xx) status, and 5xx statuses are read
 * and discarded here so the next attempt can start cleanly. Self-heal runs
 * in this loop (see above): retryable failures re-probe the hop port and
 * relaunch hop-server while it is down, then replay the original request —
 * only an exhausted gateway ever throws to the harness. */
async function hopRequestWithRetry(body, healOverrides) {
  var attemptIndex = 0;
  // Only the first retryable failure may spawn; later ones just re-confirm
  // the port (the guard daemon owns the slow loop from there on).
  var healTried = false;
  // Wall-clock budget for the whole retry sequence, measured from the first
  // failure. When it lapses the last error/response goes to the harness —
  // every layer below has already been exhausted by then.
  var budgetStart = 0;
  while (true) {
    var res;
    try {
      res = await hopRequest(body);
    } catch (err) {
      if (attemptIndex >= HOP_RETRY.maxRetries || !isRetryableHopError(err)) {
        throw err;
      }
      if (!budgetStart) budgetStart = Date.now();
      var heal = await ensureHopUp(healOverrides, !healTried);
      healTried = true;
      if (heal.action !== "already-up") {
        log("hop retry: heal " + heal.action + " after " + String(err && err.message ? err.message : err));
      }
      if (Date.now() - budgetStart > HOP_HEAL.retryBudgetMs) throw err;
      await new Promise(function (resolve) { setTimeout(resolve, hopRetryDelayMs(attemptIndex)); });
      attemptIndex += 1;
      continue;
    }
    var status = res.statusCode || 0;
    if (status >= 200 && status < 300) {
      return res;
    }
    if (attemptIndex >= HOP_RETRY.maxRetries || !isRetryableHopStatus(status)) {
      return res;
    }
    if (!budgetStart) budgetStart = Date.now();
    // An HTTP 5xx proves hop answered, but the port is still re-confirmed
    // (cheap): a hop that died between response and replay is caught here.
    var confirm = await ensureHopUp(healOverrides, !healTried);
    healTried = true;
    if (confirm.action !== "already-up") {
      log("hop retry: heal " + confirm.action + " after hop HTTP " + String(status));
    }
    if (Date.now() - budgetStart > HOP_HEAL.retryBudgetMs) return res;
    await new Promise(function (resolve) { res.resume(); setTimeout(resolve, hopRetryDelayMs(attemptIndex)); });
    attemptIndex += 1;
  }
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

  // agent may be a resolver function (from the wrap chain) or a plain plan
  // row (direct callers, tests). Resolving here — on every stream start,
  // not once at factory time — is what makes a model switch take effect
  // on the next turn without a host bounce. resolveAgent is a sync read of
  // a small JSON file, so once per turn is negligible.
  if (typeof agent === "function") {
    agent = agent();
  }
  if (!agent || !agent.modelId) {
    throw new Error("openbot: no model binding for this turn (set a wildcard or matching agent in the control UI)");
  }

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
      firstTokenMs: extra.firstTokenMs,
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
      var res = await hopRequestWithRetry(body);
      var status = res.statusCode || 0;
      if (status < 200 || status >= 300) {
        var raw = await readAll(res);
        throw new Error("openbot-runtime: hop HTTP " + status + " " + String(raw || "").slice(0, 300));
      }
      var u = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      var hopId = "";
      var yielded = [];
      var firstPartAt = 0;
      for await (var part of iterateOpenAiResponse(res, voiceTool)) {
        if (!firstPartAt) firstPartAt = Date.now();
        if (part && part.type === "finish") {
          if (part.usage) u = part.usage;
          if (part.id) hopId = part.id;
        }
        try {
          hostParts.push(jsonSafe(part, 0));
        } catch (err) {
          /* ignore */
        }
        yielded.push(part);
        yield part;
      }
      okUsage(u);
      var content = assistantMessageContent(yielded);
      var assistant = { role: "assistant", content: content };
      if (hopId) assistant.id = hopId;
      settledResponse = {
        id: hopId,
        modelId: agent.modelId,
        timestamp: new Date(),
        messages: [assistant],
      };
      if (!settled.r) {
        settled.r = true;
        resR(settledResponse);
      }
      recordCustomHost({
        status: 200,
        usage: u,
        firstTokenMs: firstPartAt ? firstPartAt - startedMs : undefined,
      });
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

// resolveAgentFn is () => agent row | null, closed over the original
// factory args. Resolving on every use (not once at factory time) is what
// makes a model switch take effect on the next turn without a host bounce.
// resolveAgent keeps its semantics (conversationId collection, wildcard
// fallback, maxOutputTokens lookup); only the call timing moves to use time.
function wrapExecutor(exec, resolveAgentFn) {
  return new Proxy(exec, {
    get: function (target, prop, receiver) {
      if (prop === "stream") {
        return function (ctx, invocationId, tools, options2) {
          return hopFullStream(target, resolveAgentFn, ctx, invocationId, tools, options2);
        };
      }
      var val = Reflect.get(target, prop, receiver);
      if (typeof val === "function") return val.bind(target);
      return val;
    },
  });
}

function currentModelId(resolveAgentFn, fallbackAgent) {
  var live = resolveAgentFn();
  if (live && live.modelId) return live.modelId;
  if (fallbackAgent && fallbackAgent.modelId) return fallbackAgent.modelId;
  throw new Error("openbot: no model binding for this turn (set a wildcard or matching agent in the control UI)");
}

function wrapPromptSession(inner, resolveAgentFn, fallbackAgent, middleware) {
  return {
    getExecutor: function (state) {
      var raw = inner.getExecutor(state);
      var hopExec = wrapExecutor(raw, resolveAgentFn);
      return middleware ? middleware(hopExec) : hopExec;
    },
    getModelId: function () {
      return currentModelId(resolveAgentFn, fallbackAgent);
    },
  };
}

function wrapProvider(stockProvider, resolveAgentFn, fallbackAgent) {
  return {
    getSession: function (middleware) {
      var inner = stockProvider.getSession(undefined);
      return wrapPromptSession(inner, resolveAgentFn, fallbackAgent, middleware);
    },
    getProviderName: function () {
      return typeof stockProvider.getProviderName === "function" ? stockProvider.getProviderName() : "proto";
    },
    getModelId: function () {
      return currentModelId(resolveAgentFn, fallbackAgent);
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
  var firstPartAt = 0;
  var fullStream = (async function* () {
    var err;
    try {
      for await (var part of original) {
        if (!firstPartAt) firstPartAt = Date.now();
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
          firstTokenMs: firstPartAt ? Math.max(0, firstPartAt - ctx.startedMs) : undefined,
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
  // Factory-time resolve is a fast fail only: the returned chain keeps a
  // resolver over the original args and re-resolves on every stream() and
  // getModelId() call, so a plan rewrite (model switch) takes effect on
  // the next turn without a host bounce.
  var agent = resolveAgent(arr);
  if (!agent || !agent.modelId) {
    throw new Error("openbot: no model binding for this turn (set a wildcard or matching agent in the control UI)");
  }
  function resolveLive() {
    return resolveAgent(arr);
  }
  return wrapProvider(callStock(stockFn, arr), resolveLive, agent);
}

function wrapSession(stockFn, args) {
  // Gateway pause gate: sync throw before any mode branch so both the
  // custom hop path and the official tap path are frozen by one switch.
  // tapSession stays sync (contract); nothing async is introduced here.
  assertNotPaused();
  if (!isCustomMode()) {
    return tapSession(stockFn, args);
  }
  return wrapHopSession(stockFn, args);
}

function attachSession(stockFn, args) {
  assertNotPaused();
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
  readPauseState: readPauseState,
  pausePath: pausePath,
  lookupMaxOutput: lookupMaxOutput,
  toOpenAIMessages: toOpenAIMessages,
  hopFullStream: hopFullStream,
  hopRequest: hopRequest,
  hopRequestWithRetry: hopRequestWithRetry,
  HOP_HEAL: HOP_HEAL,
  ensureHopUp: ensureHopUp,
  hopPortOpen: hopPortOpen,
  resetHopHealState: resetHopHealState,
  isRetryableHopStatus: isRetryableHopStatus,
  isRetryableHopError: isRetryableHopError,
  hopRetryDelayMs: hopRetryDelayMs,
  HIGH_AGENT_MAX_TOKENS: HIGH_AGENT_MAX_TOKENS,
};
