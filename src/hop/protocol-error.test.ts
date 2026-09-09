import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const hop = require("../../payload/hop-handler.cjs") as {
  handleHopRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
};

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({ server, port: addr.port });
    });
  });
}

function withHopEnv<T>(origin: string, apiType: string, fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-hop-err-"));
  const planPath = path.join(dir, "plan.json");
  const secretsPath = path.join(dir, "secrets.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      kind: "custom",
      catalog: {
        providers: [
          { id: "upstream", name: "Upstream", origin, apiType, maxTokensDefault: 65536, mapFile: "provider-maps.cjs" },
        ],
        models: [{ id: "upstream:m", providerId: "upstream", slug: "model-x", parameters: [] }],
        bindings: [],
      },
    }),
  );
  writeFileSync(secretsPath, JSON.stringify({ providers: { upstream: "sk-real" } }));
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
  const restore = () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return fn().finally(restore);
}

async function startHopServer(): Promise<{ server: http.Server; port: number }> {
  const { server, port } = await listen((req, res) => {
    void hop.handleHopRequest(req, res).then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return { server, port };
}

function postJson(
  port: number,
  body: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }> {
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
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json: JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

test("responses upstream 429 keeps status, headers, and request id after conversion", async () => {
  let hits = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      res.writeHead(429, {
        "Content-Type": "application/json",
        "x-request-id": "req-429",
        "Retry-After": "1",
      });
      res.end(JSON.stringify({
        error: { message: "rate limited", code: "rate_limit_exceeded" },
        request_id: "req-429",
      }));
    });
  });
  try {
    await withHopEnv(`http://127.0.0.1:${String(upstream.port)}/v1`, "responses", async () => {
      const hopServer = await startHopServer();
      try {
        const out = await postJson(hopServer.port, { model: "model-x", messages: [{ role: "user", content: "hi" }] });
        assert.equal(hits, 4);
        assert.equal(out.status, 429);
        assert.equal(out.headers["x-request-id"], "req-429");
        assert.equal(out.headers["retry-after"], "1");
        assert.equal(out.json.error.message, "rate limited");
        assert.equal(out.json.error.code, "rate_limit_exceeded");
        assert.equal(out.json.error.upstream_status, 429);
        assert.equal(out.json.error.request_id, "req-429");
      } finally {
        hopServer.server.close();
        hopServer.server.closeAllConnections();
      }
    });
  } finally {
    upstream.server.close();
    upstream.server.closeAllConnections();
  }
});

test("anthropic upstream 500 keeps status and x-request-id after conversion", async () => {
  let hits = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      res.writeHead(500, {
        "Content-Type": "application/json",
        "x-request-id": "req-500",
      });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "boom" },
      }));
    });
  });
  try {
    await withHopEnv(`http://127.0.0.1:${String(upstream.port)}`, "anthropic", async () => {
      const hopServer = await startHopServer();
      try {
        const out = await postJson(hopServer.port, { model: "model-x", messages: [{ role: "user", content: "hi" }] });
        assert.equal(hits, 3);
        assert.equal(out.status, 500);
        assert.equal(out.headers["x-request-id"], "req-500");
        assert.equal(out.json.error.message, "boom");
        assert.equal(out.json.error.code, "api_error");
        assert.equal(out.json.error.upstream_status, 500);
        assert.equal("request_id" in out.json.error, false);
      } finally {
        hopServer.server.close();
        hopServer.server.closeAllConnections();
      }
    });
  } finally {
    upstream.server.close();
    upstream.server.closeAllConnections();
  }
});
