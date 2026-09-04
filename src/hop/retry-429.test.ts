import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const hopPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/hop-handler.cjs");
const hop = require(hopPath) as {
  handleHopRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  UPSTREAM_429_RETRY: {
    maxRetries: number;
    baseDelayMs: number;
    factor: number;
    maxDelayMs: number;
    budgetMs: number;
  };
  parseRetryAfterMs: (headers: http.IncomingHttpHeaders, nowMs?: number) => number | null;
  delayBefore429RetryMs: (
    attemptIndex: number,
    headers: http.IncomingHttpHeaders,
    nowMs: number,
    budgetStartedMs: number,
  ) => number | null;
};

const log = require("../../payload/request-log.cjs") as {
  saveSettings: (input: unknown) => Record<string, unknown>;
  listRequests: (query?: unknown) => { items: Array<{ status?: number; model?: string }>; total: number };
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

function withHopEnv<T>(origin: string, fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-hop-429-"));
  const planPath = path.join(dir, "plan.json");
  const secretsPath = path.join(dir, "secrets.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      kind: "custom",
      catalog: {
        providers: [
          {
            id: "zhipu",
            name: "Zhipu",
            origin,
            maxTokensDefault: 65536,
            mapFile: "provider-maps.cjs",
          },
        ],
        models: [{ id: "zhipu:glm", providerId: "zhipu", slug: "glm-5.3-flash", parameters: [] }],
        bindings: [],
      },
    }),
  );
  writeFileSync(secretsPath, JSON.stringify({ providers: { zhipu: "sk-real" } }));
  writeFileSync(path.join(dir, "openbot-logs.json"), JSON.stringify({ loggingEnabled: true, logBodies: true }));

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
    if (prev.plan === undefined) delete process.env.OPENBOT_PLAN;
    else process.env.OPENBOT_PLAN = prev.plan;
    if (prev.secrets === undefined) delete process.env.OPENBOT_SECRETS;
    else process.env.OPENBOT_SECRETS = prev.secrets;
    if (prev.sand === undefined) delete process.env.OPENBOT_SAND_DATA;
    else process.env.OPENBOT_SAND_DATA = prev.sand;
    if (prev.logs === undefined) delete process.env.OPENBOT_LOGS;
    else process.env.OPENBOT_LOGS = prev.logs;
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
): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: unknown; raw: string }> {
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
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json, raw });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function okJson() {
  return JSON.stringify({
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  });
}

test("UPSTREAM_429_RETRY policy constants are named and shaped", () => {
  assert.equal(hop.UPSTREAM_429_RETRY.maxRetries, 3);
  assert.equal(hop.UPSTREAM_429_RETRY.baseDelayMs, 500);
  assert.equal(hop.UPSTREAM_429_RETRY.factor, 2);
  assert.equal(hop.UPSTREAM_429_RETRY.maxDelayMs, 8000);
  assert.equal(hop.UPSTREAM_429_RETRY.budgetMs, 30000);
});

test("parseRetryAfterMs reads seconds and HTTP-date", () => {
  assert.equal(hop.parseRetryAfterMs({ "retry-after": "2" }), 2000);
  const now = Date.parse("Wed, 04 Sep 2026 04:00:00 GMT");
  const later = "Wed, 04 Sep 2026 04:00:05 GMT";
  assert.equal(hop.parseRetryAfterMs({ "retry-after": later }, now), 5000);
});

test("hop retries upstream 429 then returns success", async () => {
  let hits = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(okJson());
    });
  });
  try {
    await withHopEnv(`http://127.0.0.1:${String(upstream.port)}/v1`, async () => {
      const hopServer = await startHopServer();
      try {
        const out = await postJson(hopServer.port, {
          model: "glm-5.3-flash",
          messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(out.status, 200);
        assert.equal(hits, 2);
        const body = out.json as { choices: { message: { content: string } }[] };
        assert.equal(body.choices[0]?.message.content, "ok");
      } finally {
        hopServer.server.close();
        hopServer.server.closeAllConnections();
      }
    });
  } finally {
    upstream.server.close();
  }
});

test("delayBefore429RetryMs honors Retry-After over exponential backoff", () => {
  const now = 1_000_000;
  const fromHeader = hop.delayBefore429RetryMs(0, { "retry-after": "7" }, now, now);
  assert.equal(fromHeader, 7000);

  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    // Without Retry-After, delay is jittered exponential in [base/2, base].
    const samples = new Set<number>();
    for (let i = 0; i < 30; i += 1) {
      const d = hop.delayBefore429RetryMs(0, {}, now, now);
      assert.notEqual(d, null);
      samples.add(d as number);
      assert.equal((d as number) >= 250, true);
      assert.equal((d as number) <= 500, true);
    }
    assert.equal(samples.size >= 1, true);

    // Budget clamps the wait.
    const clamped = hop.delayBefore429RetryMs(0, { "retry-after": "60" }, now, now - 29_000);
    assert.equal(clamped, 1000);
  } finally {
    mock.timers.reset();
  }
});

test("hop returns the last 429 when retries are exhausted", async () => {
  let hits = 0;
  const lastBody = JSON.stringify({ error: { message: "still limited", code: "final" } });
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "0",
      });
      res.end(hits === 4 ? lastBody : JSON.stringify({ error: { message: `hit-${String(hits)}` } }));
    });
  });
  try {
    await withHopEnv(`http://127.0.0.1:${String(upstream.port)}/v1`, async () => {
      const hopServer = await startHopServer();
      try {
        const out = await postJson(hopServer.port, {
          model: "glm-5.3-flash",
          messages: [],
        });
        assert.equal(hits, 4);
        assert.equal(out.status, 429);
        assert.equal(out.headers["retry-after"], "0");
        assert.equal(out.raw, lastBody);
      } finally {
        hopServer.server.close();
        hopServer.server.closeAllConnections();
      }
    });
  } finally {
    upstream.server.close();
  }
});

test("hop does not retry after an SSE stream has already been forwarded", async () => {
  let hits = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write('data: {"choices":[{"delta":{"content":"early"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  try {
    await withHopEnv(`http://127.0.0.1:${String(upstream.port)}/v1`, async () => {
      const hopServer = await startHopServer();
      try {
        const payload = Buffer.from(
          JSON.stringify({
            model: "glm-5.3-flash",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          }),
        );
        const out = await new Promise<{ status: number; text: string }>((resolve, reject) => {
          const req = http.request(
            {
              host: "127.0.0.1",
              port: hopServer.port,
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
                resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
              });
            },
          );
          req.on("error", reject);
          req.write(payload);
          req.end();
        });
        assert.equal(out.status, 200);
        assert.match(out.text, /early/);
        assert.equal(hits, 1);
      } finally {
        hopServer.server.close();
        hopServer.server.closeAllConnections();
      }
    });
  } finally {
    upstream.server.close();
  }
});

test("hop retries stream 429 JSON before writeHead then pipes SSE", async () => {
  let hits = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"after-retry"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  try {
    await withHopEnv(`http://127.0.0.1:${String(upstream.port)}/v1`, async () => {
      const hopServer = await startHopServer();
      try {
        const payload = Buffer.from(
          JSON.stringify({
            model: "glm-5.3-flash",
            messages: [],
            stream: true,
          }),
        );
        const out = await new Promise<{ status: number; text: string; ctype: string }>((resolve, reject) => {
          const req = http.request(
            {
              host: "127.0.0.1",
              port: hopServer.port,
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
                resolve({
                  status: res.statusCode ?? 0,
                  text: Buffer.concat(chunks).toString("utf8"),
                  ctype: String(res.headers["content-type"] || ""),
                });
              });
            },
          );
          req.on("error", reject);
          req.write(payload);
          req.end();
        });
        assert.equal(hits, 2);
        assert.equal(out.status, 200);
        assert.match(out.ctype, /event-stream/);
        assert.match(out.text, /after-retry/);
      } finally {
        hopServer.server.close();
        hopServer.server.closeAllConnections();
      }
    });
  } finally {
    upstream.server.close();
  }
});

test("one requestLog row is written for a client request that retried 429", async () => {
  let hits = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      if (hits < 3) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
        res.end(JSON.stringify({ error: { message: "limited" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(okJson());
    });
  });
  try {
    await withHopEnv(`http://127.0.0.1:${String(upstream.port)}/v1`, async () => {
      const hopServer = await startHopServer();
      try {
        const before = log.listRequests({ model: "glm-5.3-flash" }).total;
        const out = await postJson(hopServer.port, {
          model: "glm-5.3-flash",
          messages: [],
        });
        assert.equal(out.status, 200);
        assert.equal(hits, 3);
        const after = log.listRequests({ model: "glm-5.3-flash" });
        assert.equal(after.total, before + 1);
        assert.equal(after.items[after.items.length - 1]?.status, 200);
      } finally {
        hopServer.server.close();
        hopServer.server.closeAllConnections();
      }
    });
  } finally {
    upstream.server.close();
  }
});
