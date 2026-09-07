import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const runtimePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/runtime.cjs");

type HopResult = {
  fullStream: AsyncIterable<Record<string, unknown>>;
};

type RuntimeModule = {
  hopFullStream: (
    exec: { getMessages: () => unknown[] },
    agent: { modelId: string; maxOutputTokens: number },
  ) => HopResult;
  hopRequestWithRetry: (body: unknown) => Promise<http.IncomingMessage>;
  isRetryableHopStatus: (status: number) => boolean;
  isRetryableHopError: (err: unknown) => boolean;
  hopRetryDelayMs: (attemptIndex: number) => number;
};

function loadRuntime(): RuntimeModule {
  delete require.cache[runtimePath];
  return require(runtimePath) as RuntimeModule;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("no port")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function withHop(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, hits: number) => void,
  run: (runtime: RuntimeModule, hits: () => number) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-rt-retry-"));
  const planPath = path.join(dir, "plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      kind: "custom",
      agents: { "*": { modelId: "k3-256k", providerId: "fusionrouter" } },
      catalog: { providers: [], models: [], bindings: [] },
    }),
  );
  const state = { hits: 0 };
  const server = await new Promise<{ server: http.Server; port: number }>((resolve) => {
    const s = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        state.hits += 1;
        handler(req, res, state.hits);
      });
    });
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({ server: s, port: addr.port });
    });
  });
  const prevPlan = process.env.OPENBOT_PLAN;
  const prevHost = process.env.OPENBOT_HOP_HOST;
  const prevPort = process.env.OPENBOT_HOP_PORT;
  process.env.OPENBOT_PLAN = planPath;
  process.env.OPENBOT_HOP_HOST = "127.0.0.1";
  process.env.OPENBOT_HOP_PORT = String(server.port);
  const runtime = loadRuntime();
  try {
    await run(runtime, () => state.hits);
  } finally {
    server.server.close();
    server.server.closeAllConnections();
    if (prevPlan === undefined) delete process.env.OPENBOT_PLAN;
    else process.env.OPENBOT_PLAN = prevPlan;
    if (prevHost === undefined) delete process.env.OPENBOT_HOP_HOST;
    else process.env.OPENBOT_HOP_HOST = prevHost;
    if (prevPort === undefined) delete process.env.OPENBOT_HOP_PORT;
    else process.env.OPENBOT_HOP_PORT = prevPort;
  }
}

function drainHop(
  runtime: RuntimeModule,
): Promise<{ errors: string[]; parts: Record<string, unknown>[] }> {
  const result = runtime.hopFullStream(
    { getMessages: () => [{ role: "user", content: "x" }] },
    { modelId: "k3-256k", maxOutputTokens: 4096 },
  );
  const errors: string[] = [];
  const parts: Record<string, unknown>[] = [];
  const pump = (async () => {
    try {
      for await (const part of result.fullStream) {
        parts.push(part);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  })();
  return pump.then(() => ({ errors, parts }));
}

test("hopRetryDelayMs and retry classifiers are shaped as documented", () => {
  const runtime = loadRuntime();
  assert.equal(runtime.hopRetryDelayMs(0), 1000);
  assert.equal(runtime.hopRetryDelayMs(1), 3000);
  assert.equal(runtime.isRetryableHopStatus(500), true);
  assert.equal(runtime.isRetryableHopStatus(502), true);
  assert.equal(runtime.isRetryableHopStatus(503), true);
  assert.equal(runtime.isRetryableHopStatus(504), true);
  assert.equal(runtime.isRetryableHopStatus(501), false);
  assert.equal(runtime.isRetryableHopStatus(429), false);
  assert.equal(runtime.isRetryableHopError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), true);
  assert.equal(runtime.isRetryableHopError(new Error("other")), false);
  assert.equal(runtime.isRetryableHopError(undefined), false);
});

test("hopFullStream retries hop 5xx before the stream starts and succeeds", async () => {
  await withHop((req, res, hits) => {
    if (hits === 1) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "hop upstream exploded" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n');
  }, async (runtime, hits) => {
    const out = await drainHop(runtime);
    assert.equal(hits(), 2);
    assert.deepEqual(out.errors, []);
    assert.equal(out.parts.some((p) => p.type === "text-delta"), true);
  });
});

test("hopFullStream keeps the openbot-runtime error format after exhausting hop 5xx retries", async () => {
  await withHop((req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "persistent failure" } }));
  }, async (runtime, hits) => {
    const out = await drainHop(runtime);
    assert.equal(hits(), 3);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0] ?? "", /^openbot-runtime: hop HTTP 500/);
    assert.match(out.errors[0] ?? "", /persistent failure/);
  });
});

test("hopFullStream does not retry a hop 400", async () => {
  await withHop((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad request" } }));
  }, async (runtime, hits) => {
    const out = await drainHop(runtime);
    assert.equal(hits(), 1);
    assert.match(out.errors[0] ?? "", /^openbot-runtime: hop HTTP 400/);
  });
});

test("hopFullStream retries ECONNREFUSED when hop is down then succeeds", async () => {
  const deadPort = await freePort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-rt-dead-"));
  const planPath = path.join(dir, "plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      kind: "custom",
      agents: { "*": { modelId: "k3-256k", providerId: "fusionrouter" } },
      catalog: { providers: [], models: [], bindings: [] },
    }),
  );
  const prevPlan = process.env.OPENBOT_PLAN;
  const prevHost = process.env.OPENBOT_HOP_HOST;
  const prevPort = process.env.OPENBOT_HOP_PORT;
  process.env.OPENBOT_PLAN = planPath;
  process.env.OPENBOT_HOP_HOST = "127.0.0.1";
  process.env.OPENBOT_HOP_PORT = String(deadPort);
  const runtime = loadRuntime();
  try {
    const result = runtime.hopFullStream(
      { getMessages: () => [{ role: "user", content: "x" }] },
      { modelId: "k3-256k", maxOutputTokens: 4096 },
    );
    const errors: string[] = [];
    const parts: Record<string, unknown>[] = [];
    try {
      for await (const part of result.fullStream) parts.push(part);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    assert.deepEqual(
      parts.filter((p) => p.type !== "error"),
      [],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /ECONNREFUSED|hop HTTP 0/);
  } finally {
    if (prevPlan === undefined) delete process.env.OPENBOT_PLAN;
    else process.env.OPENBOT_PLAN = prevPlan;
    if (prevHost === undefined) delete process.env.OPENBOT_HOP_HOST;
    else process.env.OPENBOT_HOP_HOST = prevHost;
    if (prevPort === undefined) delete process.env.OPENBOT_HOP_PORT;
    else process.env.OPENBOT_HOP_PORT = prevPort;
  }
});
