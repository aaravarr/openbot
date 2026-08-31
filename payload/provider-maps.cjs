"use strict";

function param(parameters, id) {
  if (!Array.isArray(parameters)) return undefined;
  for (var i = 0; i < parameters.length; i++) {
    var p = parameters[i];
    if (p && p.id === id) return p.value;
  }
  return undefined;
}

var GLM_MODEL_RE = /^glm[-.\d]/i;
var GLM_BASE_RE = /bigmodel\.cn/;
var GROK_MODEL_RE = /^grok[-.]/i;

function isGlmRoute(modelId, baseUrl) {
  return GLM_MODEL_RE.test(String(modelId || "")) || GLM_BASE_RE.test(String(baseUrl || ""));
}

function isGrokRoute(modelId, baseUrl) {
  return GROK_MODEL_RE.test(String(modelId || "")) || /api\.x\.ai/.test(String(baseUrl || ""));
}

function applyGlm(body, parameters) {
  var fast = param(parameters, "fast");
  if (fast === true || String(fast).toLowerCase() === "true") {
    body.thinking = { type: "disabled" };
    return "glm-fast-off";
  }
  var effort = param(parameters, "effort");
  var glmEffort = { low: "low", medium: "medium", high: "high", max: "max", xhigh: "max" };
  var token = effort != null ? glmEffort[String(effort)] : undefined;
  if (token) {
    if (!body.thinking) body.thinking = { type: "enabled" };
    if (body.reasoning_effort == null) body.reasoning_effort = token;
    return "glm-effort";
  }
  var thinking = param(parameters, "thinking");
  if (thinking === false || String(thinking).toLowerCase() === "false") {
    body.thinking = { type: "disabled" };
    return "glm-thinking-off";
  }
  return null;
}

function applyGrok(body, maxMode, parameters) {
  var effortToXai = { low: "low", medium: "medium", high: "high", max: "xhigh", xhigh: "xhigh" };
  if (maxMode === true) {
    body.reasoning_effort = "xhigh";
    return "grok-max";
  }
  var fast = param(parameters, "fast");
  if (fast === true || String(fast).toLowerCase() === "true") {
    body.reasoning_effort = "low";
    return "grok-fast";
  }
  var effort = param(parameters, "effort");
  if (effort != null && Object.prototype.hasOwnProperty.call(effortToXai, String(effort))) {
    body.reasoning_effort = effortToXai[String(effort)];
    return "grok-effort";
  }
  return null;
}

function applyGeneric(body, parameters) {
  var effort = param(parameters, "effort");
  var openaiEffort = { low: "low", medium: "medium", high: "high", max: "high", xhigh: "high" };
  var token = effort != null ? openaiEffort[String(effort)] : undefined;
  if (token && body.reasoning_effort == null) {
    body.reasoning_effort = token;
    return "openai-effort";
  }
  return "none";
}

function applyProviderReasoningControls(body, ctx) {
  ctx = ctx || {};
  var modelId = String(ctx.modelId || "");
  var baseUrl = String(ctx.baseUrl || "");
  if (isGrokRoute(modelId, baseUrl)) {
    return applyGrok(body, ctx.maxMode === true, ctx.parameters) || "grok-passthrough";
  }
  if (isGlmRoute(modelId, baseUrl)) {
    return applyGlm(body, ctx.parameters) || "glm-passthrough";
  }
  return applyGeneric(body, ctx.parameters);
}

module.exports = {
  applyProviderReasoningControls: applyProviderReasoningControls,
  isGlmRoute: isGlmRoute,
  isGrokRoute: isGrokRoute,
};
