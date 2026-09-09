import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const hopPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/hop-handler.cjs");
const hop = require(hopPath) as {
  handleHopRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  readPauseBotsState: () => string[];
  isBotPaused: (botId: string) => boolean;
};

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({ server, port: address.port });
    });
  });
}

function post(port: number, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(payload.length) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("bot pause short-circuits matching hop requests and fails open for missing/corrupt state", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-bot-pause-"));
  const botId = "123e4567-e89b-12d3-a456-426614174000";
  const old = { plan: process.env.OPENBOT_PLAN, sand: process.env.OPENBOT_SAND_DATA, logs: process.env.OPENBOT_LOGS };
  process.env.OPENBOT_SAND_DATA = dir;
  process.env.OPENBOT_PLAN = path.join(dir, "openbot-plan.json");
  process.env.OPENBOT_LOGS = path.join(dir, "openbot-logs.json");
  writeFileSync(process.env.OPENBOT_PLAN, JSON.stringify({ kind: "custom", catalog: { providers: [{ id: "p", name: "P", origin: "http://127.0.0.1:1/v1", maxTokensDefault: 100, mapFile: "provider-maps.cjs" }], models: [{ id: "p:m", providerId: "p", slug: "m", parameters: [] }], bindings: [{ conversation: { kind: "wildcard" }, modelId: "p:m" }] } }));
  writeFileSync(process.env.OPENBOT_LOGS, JSON.stringify({ loggingEnabled: false }));
  const server = await listen((req, res) => { void hop.handleHopRequest(req, res); });
  try {
    const body = { model: "m", messages: [{ role: "system", content: "/home/box/agent-data/agents/" + botId + "/profile.json" }, { role: "user", content: "hello" }] };
    assert.deepEqual(hop.readPauseBotsState(), []);
    const open = await post(server.port, body);
    assert.notDeepEqual(open.json, { error: { message: "openbot bot paused", code: "bot_paused", botId } });
    writeFileSync(path.join(dir, "openbot-pause-bots.json"), JSON.stringify({ pausedBotIds: [botId] }));
    assert.equal(hop.isBotPaused(botId), true);
    const paused = await post(server.port, body);
    assert.equal(paused.status, 503);
    assert.deepEqual(paused.json, { error: { message: "openbot bot paused", code: "bot_paused", botId } });
    writeFileSync(path.join(dir, "openbot-pause-bots.json"), "{broken");
    assert.deepEqual(hop.readPauseBotsState(), []);
    assert.equal(hop.isBotPaused(botId), false);
  } finally {
    server.server.close();
    server.server.closeAllConnections();
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
