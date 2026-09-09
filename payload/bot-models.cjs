"use strict";

var fs = require("fs");
var path = require("path");
var requestLog = require("./request-log.cjs");

function botModelsPath() {
  if (process.env.OPENBOT_BOT_MODELS) return process.env.OPENBOT_BOT_MODELS;
  var root = process.env.OPENBOT_SAND_DATA || (process.env.OPENBOT_PLAN ? path.dirname(process.env.OPENBOT_PLAN) : "/home/box/sand-data");
  return path.join(root, "openbot-bot-models.json");
}

// Read on every request (no cache): an assignment edit takes effect on the
// next message without a host bounce, mirroring the plan reload discipline.
// Missing or corrupt file = no assignments (fail open, never wedge chat).
function readBotModels() {
  try {
    var parsed = JSON.parse(fs.readFileSync(botModelsPath(), "utf8"));
    var assignments = parsed && parsed.assignments;
    if (!assignments || typeof assignments !== "object" || Array.isArray(assignments)) return {};
    var out = {};
    Object.keys(assignments).forEach(function (botId) {
      if (typeof assignments[botId] === "string" && assignments[botId].trim()) out[botId] = assignments[botId];
    });
    return out;
  } catch (err) {
    return {};
  }
}

function writeBotModels(assignments) {
  var file = botModelsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  var tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ assignments: assignments }, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function extractBotId(messages) {
  var context = requestLog.extractChatContext(messages);
  return context && typeof context.botId === "string" && context.botId ? context.botId : undefined;
}

function modelInPlan(plan, modelId) {
  var models = plan && plan.catalog && plan.catalog.models;
  if (!Array.isArray(models)) return false;
  for (var i = 0; i < models.length; i++) {
    var row = models[i];
    if (row && (row.id === modelId || row.slug === modelId)) return true;
  }
  return false;
}

// Resolve the per-bot override for one request. Returns undefined when the
// messages carry no bot identity or no assignment exists. When the assignment
// points at a model that is no longer in the plan catalog, the result is
// marked stale so callers fall back to the global model instead of failing
// the chat; the API still validates on save, so stale only happens after a
// model is removed from the catalog.
function resolveAssignment(messages, plan) {
  var botId = extractBotId(messages);
  if (!botId) return undefined;
  var assignments = readBotModels();
  var modelId = assignments[botId] || assignments[botId.toLowerCase()];
  if (!modelId) return undefined;
  return { botId: botId, modelId: modelId, stale: !modelInPlan(plan, modelId) };
}

exports.botModelsPath = botModelsPath;
exports.readBotModels = readBotModels;
exports.writeBotModels = writeBotModels;
exports.extractBotId = extractBotId;
exports.resolveAssignment = resolveAssignment;
