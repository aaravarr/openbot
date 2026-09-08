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
  readPauseState: () => boolean;
};

const log = require("../../payload/request-log.cjs") as {
  listRequests: (query?: unknown) => { items: Array<{ status?: number; error?: string }>; total: number };
};

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("no port");
      }
      resolve({ server, port: addr.port });
    });
  });
}

function postJson(
  port: number,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
          Authorization: "Bearer openbot-runtime",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = JSON.parse(raw) as unknown;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

test("paused hop returns 503 paused, logs it, and touches no upstream", async () => {
  let upstreamHits = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      upstreamHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-hop-pause-"));
  const planPath = path.join(dir, "plan.json");
  const secretsPath = path.join(dir, "secrets.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      kind: "custom",
      catalog: {
        providers: [
          {
            id: "fusionrouter",
            name: "FusionRouter",
            origin: `http://127.0.0.1:${String(upstream.port)}/v1`,
            maxTokensDefault: 65536,
            mapFile: "provider-maps.cjs",
          },
        ],
        models: [{ id: "fusionrouter:k3", providerId: "fusionrouter", slug: "k3-256k", parameters: [] }],
        bindings: [],
      },
    }),
  );
  writeFileSync(secretsPath, JSON.stringify({ providers: { fusionrouter: "sk-real" } }));
  writeFileSync(path.join(dir, "openbot-logs.json"), JSON.stringify({ loggingEnabled: true, logBodies: true }));
  const pauseFile = path.join(dir, "openbot-pause.json");

  const prev = {
    plan: process.env.OPENBOT_PLAN,
    secrets: process.env.OPENBOT_SECRETS,
    sand: process.env.OPENBOT_SAND_DATA,
    logs: process.env.OPENBOT_LOGS,
  };
  process.env.OPENBOT_PLAN = planPath;
  process.env.OPENBOT_SECRETS = secretsPath;
  process.env.OPENBOT_SAND_DATA = dir;
  process.env.OPENBOT_LOGS = path.join(dir, "openbot-logs.json");
  const hopServer = await listen((req, res) => {
    void hop.handleHopRequest(req, res).then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  try {
    const body = { model: "k3-256k", messages: [{ role: "user", content: "hi" }] };
    const ok = await postJson(hopServer.port, body);
    assert.equal(ok.status, 200);
    assert.equal(upstreamHits, 1);

    writeFileSync(pauseFile, JSON.stringify({ paused: true, at: new Date().toISOString() }));
    assert.equal(hop.readPauseState(), true);
    const before = log.listRequests().total;
    const paused = await postJson(hopServer.port, body);
    assert.equal(paused.status, 503);
    assert.deepEqual(paused.json, { error: { message: "openbot gateway paused", code: "paused" } });
    assert.equal(upstreamHits, 1);
    const rows = log.listRequests().items.slice(0, log.listRequests().total - before);
    assert.equal(
      rows.some((row) => row.status === 503 && row.error === "openbot gateway paused"),
      true,
    );

    rmSync(pauseFile);
    const resumed = await postJson(hopServer.port, body);
    assert.equal(resumed.status, 200);
    assert.equal(upstreamHits, 2);

    writeFileSync(pauseFile, "{corrupt");
    assert.equal(hop.readPauseState(), false);
    const failOpen = await postJson(hopServer.port, body);
    assert.equal(failOpen.status, 200);
    assert.equal(upstreamHits, 3);
  } finally {
    hopServer.server.close();
    hopServer.server.closeAllConnections();
    upstream.server.close();
    upstream.server.closeAllConnections();
    if (prev.plan === undefined) delete process.env.OPENBOT_PLAN;
    else process.env.OPENBOT_PLAN = prev.plan;
    if (prev.secrets === undefined) delete process.env.OPENBOT_SECRETS;
    else process.env.OPENBOT_SECRETS = prev.secrets;
    if (prev.sand === undefined) delete process.env.OPENBOT_SAND_DATA;
    else process.env.OPENBOT_SAND_DATA = prev.sand;
    if (prev.logs === undefined) delete process.env.OPENBOT_LOGS;
    else process.env.OPENBOT_LOGS = prev.logs;
  }
});
