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
  UPSTREAM_5XX_RETRY: {
    maxRetries: number;
    baseDelayMs: number;
    factor: number;
    maxDelayMs: number;
    budgetMs: number;
  };
  isRetryableUpstreamStatus: (status: number) => boolean;
  isRetryableUpstreamError: (err: unknown) => boolean;
  canRetryUpstreamStatus: (
    status: number,
    attemptIndex: number,
    clientRes: { headersSent?: boolean } | null,
    sleepSpentMs: number,
  ) => boolean;
  canRetryUpstreamError: (
    err: unknown,
    attemptIndex: number,
    clientRes: { headersSent?: boolean } | null,
    sleepSpentMs: number,
  ) => boolean;
  classifyUpstreamRetry: (
    status: number,
    attemptIndex: number,
    clientRes: { headersSent?: boolean } | null,
    sleepSpentMs: number,
  ) => "429" | "5xx" | null;
  delayBefore5xxRetryMs: (
    attemptIndex: number,
    headers: http.IncomingHttpHeaders,
    nowMs?: number,
    sleepSpentMs?: number,
  ) => number | null;
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

function withHopEnv<T>(origin: string, fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-hop-5xx-"));
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
            origin,
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

function postStream(
  port: number,
  body: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; ctype: string }> {
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
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
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
}

function okJson() {
  return JSON.stringify({
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  });
}

function streamBody(): Record<string, unknown> {
  return { model: "k3-256k", messages: [{ role: "user", content: "hi" }], stream: true };
}

test("UPSTREAM_5XX_RETRY policy constants are named and shaped", () => {
  assert.equal(hop.UPSTREAM_5XX_RETRY.maxRetries, 2);
  assert.equal(hop.UPSTREAM_5XX_RETRY.baseDelayMs, 500);
  assert.equal(hop.UPSTREAM_5XX_RETRY.factor, 3);
  assert.equal(hop.UPSTREAM_5XX_RETRY.maxDelayMs, 5000);
  assert.equal(hop.UPSTREAM_5XX_RETRY.budgetMs, 10000);
});

test("retryable upstream statuses and errors are classified", () => {
  assert.equal(hop.isRetryableUpstreamStatus(500), true);
  assert.equal(hop.isRetryableUpstreamStatus(502), true);
  assert.equal(hop.isRetryableUpstreamStatus(503), true);
  assert.equal(hop.isRetryableUpstreamStatus(504), true);
  // Cloudflare edge errors: 524 (origin timeout) is the one production hits;
  // 521/525 stay non-retryable (config-level failures).
  assert.equal(hop.isRetryableUpstreamStatus(524), true);
  assert.equal(hop.isRetryableUpstreamStatus(520), true);
  assert.equal(hop.isRetryableUpstreamStatus(522), true);
  assert.equal(hop.isRetryableUpstreamStatus(523), true);
  assert.equal(hop.isRetryableUpstreamStatus(526), true);
  assert.equal(hop.isRetryableUpstreamStatus(527), true);
  assert.equal(hop.isRetryableUpstreamStatus(521), false);
  assert.equal(hop.isRetryableUpstreamStatus(525), false);
  assert.equal(hop.isRetryableUpstreamStatus(501), false);
  assert.equal(hop.isRetryableUpstreamStatus(429), false);
  assert.equal(hop.isRetryableUpstreamError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), true);
  assert.equal(hop.isRetryableUpstreamError(Object.assign(new Error("fetch failed"), { code: "ETIMEDOUT" })), true);
  assert.equal(hop.isRetryableUpstreamError(new Error("openbot-hop: upstream timeout")), true);
  assert.equal(hop.isRetryableUpstreamError(Object.assign(new Error("nope"), { code: "EINVAL" })), false);
  assert.equal(hop.isRetryableUpstreamError(undefined), false);
});

test("delayBefore5xxRetryMs uses exponential backoff and honors Retry-After", () => {
  const now = 2_000_000;
  const fromHeader = hop.delayBefore5xxRetryMs(0, { "retry-after": "3" }, now, 0);
  assert.equal(fromHeader, 3000);

  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const samples = new Set<number>();
    for (let i = 0; i < 30; i += 1) {
      const d = hop.delayBefore5xxRetryMs(0, {}, now, 0);
      assert.notEqual(d, null);
      samples.add(d as number);
      assert.equal((d as number) >= 250, true);
      assert.equal((d as number) <= 500, true);
    }
    assert.equal(samples.size >= 1, true);
    const step1 = hop.delayBefore5xxRetryMs(1, {}, now, 0);
    assert.equal((step1 as number) >= 750, true);
    assert.equal((step1 as number) <= 1500, true);
  } finally {
    mock.timers.reset();
  }
});

test("canRetry helpers stop at the retry cap and sleep budget", () => {
  // The budget is backoff sleep, not wall clock: a failure that took 125s to
  // arrive (Cloudflare 524 origin timeout) must still be retryable.
  assert.equal(hop.canRetryUpstreamStatus(500, 0, null, 0), true);
  assert.equal(hop.canRetryUpstreamStatus(524, 0, null, 0), true);
  assert.equal(hop.canRetryUpstreamStatus(500, 2, null, 0), false);
  assert.equal(hop.canRetryUpstreamStatus(503, 1, { headersSent: true }, 0), false);
  assert.equal(hop.canRetryUpstreamStatus(500, 0, null, 10_000), false);
  assert.equal(hop.canRetryUpstreamStatus(500, 0, null, 9_999), true);
  assert.equal(hop.canRetryUpstreamError({ code: "ECONNRESET" }, 0, null, 0), true);
  assert.equal(hop.canRetryUpstreamError({ code: "ECONNRESET" }, 2, null, 0), false);
  assert.equal(hop.canRetryUpstreamError({ code: "ECONNRESET" }, 0, null, 10_000), false);
  assert.equal(hop.classifyUpstreamRetry(429, 0, null, 0), "429");
  assert.equal(hop.classifyUpstreamRetry(500, 0, null, 0), "5xx");
  assert.equal(hop.classifyUpstreamRetry(524, 0, null, 0), "5xx");
  assert.equal(hop.classifyUpstreamRetry(504, 3, null, 0), null);
  assert.equal(hop.classifyUpstreamRetry(400, 0, null, 0), null);
});

test("hop retries upstream 500 then returns success", async () => {
  let hits = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "internal error" } }));
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
        const out = await postJson(hopServer.port, { model: "k3-256k", messages: [{ role: "user", content: "hi" }] });
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
    upstream.server.closeAllConnections();
  }
});

test("hop returns the upstream 500 after retries are exhausted", async () => {
  let hits = 0;
  const lastBody = JSON.stringify({ error: { message: "still broken", code: "final" } });
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(hits === 3 ? lastBody : JSON.stringify({ error: { message: `hit-${String(hits)}` } }));
    });
  });
  try {
    await withHopEnv(`http://127.0.0.1:${String(upstream.port)}/v1`, async () => {
      const hopServer = await startHopServer();
      try {
        const before = log.listRequests({ model: "k3-256k" }).total;
        const out = await postJson(hopServer.port, { model: "k3-256k", messages: [] });
        assert.equal(hits, 3);
        assert.equal(out.status, 500);
        assert.equal(out.raw, lastBody);
        const after = log.listRequests({ model: "k3-256k" });
        assert.equal(after.total, before + 1);
        const row = after.items[after.items.length - 1];
        assert.equal(row?.status, 500);
        assert.match(row?.error ?? "", /upstream-retries=2/);
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

test("hop retries a Cloudflare 524 then returns success", async () => {
  let hits = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(524, { "Content-Type": "text/plain" });
        res.end("524 origin timeout");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(okJson());
    });
  });
  try {
    await withHopEnv("http://127.0.0.1:" + String(upstream.port) + "/v1", async () => {
      const hopServer = await startHopServer();
      try {
        const out = await postJson(hopServer.port, { model: "k3-256k", messages: [{ role: "user", content: "hi" }] });
        assert.equal(out.status, 200);
        assert.equal(hits, 2);
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

test("hop retries network-layer ECONNRESET then succeeds", async () => {
  let hits = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      if (hits === 1) {
        res.destroy();
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
        const out = await postJson(hopServer.port, { model: "k3-256k", messages: [] });
        assert.equal(out.status, 200);
        assert.equal(hits, 2);
      } finally {
        hopServer.server.close();
        hopServer.server.closeAllConnections();
      }
    });
  } finally {
    upstream.server.close();
    upstream.server.closeAllConnections();
  }
  assert.equal(hits, 2);
});

test("hop retries stream 502 JSON before writeHead then pipes SSE", async () => {
  let hits = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(502, { "Content-Type": "application/json", "Retry-After": "0" });
        res.end(JSON.stringify({ error: { message: "bad gateway from origin" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"after-502-retry"}}]\n\ndata: [DONE]\n\n');
    });
  });
  try {
    await withHopEnv(`http://127.0.0.1:${String(upstream.port)}/v1`, async () => {
      const hopServer = await startHopServer();
      try {
        const out = await postStream(hopServer.port, streamBody());
        assert.equal(hits, 2);
        assert.equal(out.status, 200);
        assert.match(out.ctype, /event-stream/);
        assert.match(out.text, /after-502-retry/);
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

test("hop does not retry once an SSE stream started forwarding", async () => {
  let hits = 0;
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write('data: {"choices":[{"delta":{"content":"early"}}]\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  try {
    await withHopEnv(`http://127.0.0.1:${String(upstream.port)}/v1`, async () => {
      const hopServer = await startHopServer();
      try {
        const out = await postStream(hopServer.port, streamBody());
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
    upstream.server.closeAllConnections();
  }
});
