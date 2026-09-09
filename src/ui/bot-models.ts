import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { Catalog } from "../domain/types.ts";
import type { SupervisorDeps } from "../supervisor/observe.ts";

function filePath(current: SupervisorDeps): string {
  return process.env.OPENBOT_BOT_MODELS ?? path.join(current.paths.sandData, "openbot-bot-models.json");
}

function readAssignments(current: SupervisorDeps): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath(current), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const assignments = (parsed as { assignments?: unknown }).assignments;
    if (!assignments || typeof assignments !== "object" || Array.isArray(assignments)) return {};
    return Object.fromEntries(
      Object.entries(assignments).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0),
    );
  } catch {
    return {};
  }
}

function writeAssignments(current: SupervisorDeps, assignments: Record<string, string>): void {
  const target = filePath(current);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ assignments }, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function handleBotModelsApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  current: SupervisorDeps,
  readBody: (req: http.IncomingMessage) => Promise<string>,
  sendJson: (res: http.ServerResponse, status: number, payload: unknown) => void,
  catalogFromPlan: (raw: string | undefined) => Catalog,
): Promise<boolean> {
  if (url.pathname !== "/api/bot-models" || (req.method !== "GET" && req.method !== "PUT")) return false;
  const catalog = catalogFromPlan(current.fs.read(current.paths.plan));
  const available = catalog.models.map((model) => String(model.id));
  if (req.method === "GET") {
    sendJson(res, 200, { assignments: readAssignments(current), available });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: "invalid json" });
    return true;
  }
  const next = readAssignments(current);
  if (!isRecord(body)) {
    sendJson(res, 400, { error: "expected botId/modelId or assignments" });
    return true;
  }
  if ("assignments" in body) {
    const input = body.assignments;
    if (!isRecord(input)) {
      sendJson(res, 400, { error: "assignments must be an object" });
      return true;
    }
    const replacement: Record<string, string> = {};
    for (const [botId, modelId] of Object.entries(input)) {
      if (!botId.trim() || typeof modelId !== "string" || !available.includes(modelId)) {
        sendJson(res, 400, { error: `unknown modelId: ${String(modelId)}` });
        return true;
      }
      replacement[botId] = modelId;
    }
    Object.keys(next).forEach((botId) => delete next[botId]);
    Object.assign(next, replacement);
  } else {
    const botId = body.botId;
    const modelId = body.modelId;
    if (typeof botId !== "string" || !botId.trim()) {
      sendJson(res, 400, { error: "botId is required" });
      return true;
    }
    if (modelId === null || modelId === "") delete next[botId];
    else if (typeof modelId !== "string" || !available.includes(modelId)) {
      sendJson(res, 400, { error: `unknown modelId: ${String(modelId)}` });
      return true;
    } else next[botId] = modelId;
  }
  try {
    writeAssignments(current, next);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : "could not save bot models" });
    return true;
  }
  sendJson(res, 200, { assignments: next, available });
  return true;
}
