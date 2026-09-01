import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const log = require("../../payload/request-log.cjs") as {
  DEFAULTS: {
    loggingEnabled: boolean;
    logBodies: boolean;
    logBodiesOnError: boolean;
    logRetentionDays: number;
    maxBodyCaptureBytes: number;
    maxRecords: number;
  };
  loadSettings: () => Record<string, unknown>;
  saveSettings: (input: unknown) => Record<string, unknown>;
  recordHop: (input: unknown) => void;
  listRequests: (query?: unknown) => { items: Record<string, unknown>[]; total: number; page: number; pageSize: number };
  getRequest: (id: string) => Record<string, unknown> | null;
  clearRequests: () => void;
  redact: (value: unknown, secrets?: string[]) => unknown;
};

const hopServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/hop-server.cjs");

function withSand<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-logs-"));
  const prevSand = process.env.OPENBOT_SAND_DATA;
  const prevLogs = process.env.OPENBOT_LOGS;
  const prevSecrets = process.env.OPENBOT_SECRETS;
  process.env.OPENBOT_SAND_DATA = dir;
  delete process.env.OPENBOT_LOGS;
  process.env.OPENBOT_SECRETS = path.join(dir, "secrets.json");
  try {
    return fn(dir);
  } finally {
    if (prevSand === undefined) {
      delete process.env.OPENBOT_SAND_DATA;
    } else {
      process.env.OPENBOT_SAND_DATA = prevSand;
    }
    if (prevLogs === undefined) {
      delete process.env.OPENBOT_LOGS;
    } else {
      process.env.OPENBOT_LOGS = prevLogs;
    }
    if (prevSecrets === undefined) {
      delete process.env.OPENBOT_SECRETS;
    } else {
      process.env.OPENBOT_SECRETS = prevSecrets;
    }
  }
}

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

function post(port: number, body: unknown): Promise<{ status: number; json: unknown }> {
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
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) as unknown });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function freePort(): Promise<number> {
  const hop = await listen(() => undefined);
  const port = hop.port;
  hop.server.close();
  return port;
}

async function startHop(input: {
  dir: string;
  plan: unknown;
  secrets: unknown;
}): Promise<{ port: number; child: ChildProcess }> {
  const planPath = path.join(input.dir, "openbot-plan.json");
  const secretsPath = path.join(input.dir, "secrets.json");
  writeFileSync(planPath, JSON.stringify(input.plan));
  writeFileSync(secretsPath, JSON.stringify(input.secrets));
  const port = await freePort();
  const child = spawn(process.execPath, [hopServer], {
    env: {
      ...process.env,
      OPENBOT_HOP_HOST: "127.0.0.1",
      OPENBOT_HOP_PORT: String(port),
      OPENBOT_SAND_DATA: input.dir,
      OPENBOT_LOGS: path.join(input.dir, "openbot-logs.json"),
      OPENBOT_PLAN: planPath,
      OPENBOT_SECRETS: secretsPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hop did not start")), 3000);
    child.stdout.on("data", (buf: Buffer) => {
      if (buf.toString("utf8").includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
  });
  return { port, child };
}

function planFor(origin: string) {
  return {
    kind: "custom",
    catalog: {
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek",
          origin,
          maxTokensDefault: 65536,
          mapFile: "provider-maps.cjs",
        },
      ],
      models: [{ id: "deepseek:v4", providerId: "deepseek", slug: "deepseek-v4-flash", parameters: [] }],
      bindings: [],
    },
  };
}

function scanDir(dir: string): string {
  const names = ["openbot-logs.json", "openbot-requests.jsonl"];
  const chunks: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (existsSync(file)) {
      chunks.push(readFileSync(file, "utf8"));
    }
  }
  const bodies = path.join(dir, "openbot-request-bodies");
  if (existsSync(bodies)) {
    for (const name of readdirSync(bodies)) {
      chunks.push(readFileSync(path.join(bodies, name), "utf8"));
    }
  }
  return chunks.join("\n");
}

test("missing settings file uses defaults with logging off", () => {
  withSand((dir) => {
    const settings = log.loadSettings();
    assert.equal(settings.loggingEnabled, false);
    assert.equal(settings.logBodies, false);
    assert.equal(settings.logBodiesOnError, true);
    assert.equal(settings.logRetentionDays, 7);
    assert.equal(settings.maxBodyCaptureBytes, 65536);
    assert.equal(settings.maxRecords, 200);
    assert.equal(existsSync(path.join(dir, "openbot-logs.json")), false);
  });
});

test("redact strips Authorization, bearer tokens, sk- patterns, and secret values", () => {
  const secret = "glm-plain-secret-value";
  const out = log.redact(
    {
      Authorization: "Bearer sk-should-not-leak",
      note: `token sk-or-abc123 and ocg_live99 and ${secret}`,
    },
    [secret],
  ) as { Authorization: string; note: string };
  assert.equal(out.Authorization, "[redacted]");
  assert.equal(out.note.includes("sk-or-abc123"), false);
  assert.equal(out.note.includes("ocg_live99"), false);
  assert.equal(out.note.includes(secret), false);
  assert.match(out.note, /\[redacted\]/);
});

test("saveSettings rejects out-of-range retention", () => {
  withSand(() => {
    assert.throws(() => log.saveSettings({ logRetentionDays: 0 }), /retention/i);
    assert.throws(() => log.saveSettings({ maxBodyCaptureBytes: 12 }), /capture/i);
  });
});

test("recordHop is a no-op when logging is off", () => {
  withSand((dir) => {
    log.recordHop({ status: 200, model: "glm-5.3-flash", requestBody: { model: "glm-5.3-flash" } });
    assert.equal(existsSync(path.join(dir, "openbot-requests.jsonl")), false);
  });
});

test("enabled record writes metadata without bodies by default on success", () => {
  withSand((dir) => {
    writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ providers: { deepseek: "sk-test-log-secret" } }));
    log.saveSettings({ loggingEnabled: true, logBodies: false, logBodiesOnError: true });
    log.recordHop({
      id: "req-success-01",
      status: 200,
      model: "deepseek-v4-flash",
      providerId: "deepseek",
      providerName: "DeepSeek",
      requestBody: { model: "deepseek-v4-flash", messages: [] },
      responseBody: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    });
    const listed = log.listRequests();
    assert.equal(listed.total, 1);
    const row = listed.items[0];
    assert.equal(row?.ok, true);
    assert.equal(row?.model, "deepseek-v4-flash");
    assert.equal(row?.hasRequest, false);
    assert.equal(row?.hasResponse, false);
    assert.equal(row?.promptTokens, 3);
    assert.equal(existsSync(path.join(dir, "openbot-request-bodies", "req-success-01.json")), false);
    const dump = scanDir(dir);
    assert.equal(dump.includes("sk-test-log-secret"), false);
    assert.equal(dump.includes("Authorization"), false);
  });
});

test("upstream-shaped 400 JSON keeps ok false and the error string", () => {
  withSand((dir) => {
    log.saveSettings({ loggingEnabled: true, logBodies: false, logBodiesOnError: true });
    log.recordHop({
      id: "req-error-01",
      status: 400,
      model: "deepseek-v4-flash",
      requestBody: { model: "deepseek-v4-flash" },
      responseRaw: JSON.stringify({ error: { message: "missing field tool_call_id" } }),
    });
    const row = log.listRequests().items[0];
    assert.equal(row?.ok, false);
    assert.equal(row?.error, "missing field tool_call_id");
    assert.equal(row?.hasRequest, true);
    const detail = log.getRequest("req-error-01");
    assert.ok(detail);
    assert.equal(existsSync(path.join(dir, "openbot-request-bodies", "req-error-01.json")), true);
  });
});

test("logBodiesOnError keeps a body on error only", () => {
  withSand((dir) => {
    log.saveSettings({ loggingEnabled: true, logBodies: false, logBodiesOnError: true });
    log.recordHop({
      id: "req-ok-body",
      status: 200,
      model: "glm-5.3-flash",
      requestBody: { model: "glm-5.3-flash" },
      responseBody: { choices: [{ message: { content: "ok" } }] },
    });
    log.recordHop({
      id: "req-bad-body",
      status: 400,
      model: "glm-5.3-flash",
      requestBody: { model: "glm-5.3-flash" },
      responseBody: { error: { message: "bad request" } },
    });
    assert.equal(existsSync(path.join(dir, "openbot-request-bodies", "req-ok-body.json")), false);
    assert.equal(existsSync(path.join(dir, "openbot-request-bodies", "req-bad-body.json")), true);
  });
});

test("prune keeps only maxRecords newest rows and deletes orphan bodies", () => {
  withSand((dir) => {
    log.saveSettings({ loggingEnabled: true, maxRecords: 3, logBodies: true, logBodiesOnError: true });
    const origin = Date.now();
    for (let i = 1; i <= 5; i += 1) {
      log.recordHop({
        id: `req-prune-0${String(i)}`,
        startedAt: new Date(origin + i * 1000).toISOString(),
        status: 200,
        model: `m${String(i)}`,
        requestBody: { model: `m${String(i)}` },
        responseBody: { ok: true },
      });
    }
    const listed = log.listRequests();
    assert.equal(listed.total, 3);
    assert.deepEqual(
      listed.items.map((row) => row.model),
      ["m5", "m4", "m3"],
    );
    const bodies = readdirSync(path.join(dir, "openbot-request-bodies")).sort();
    assert.deepEqual(bodies, ["req-prune-03.json", "req-prune-04.json", "req-prune-05.json"]);
  });
});

test("listRequests filters q, ok, and model newest-first", () => {
  withSand(() => {
    log.saveSettings({ loggingEnabled: true });
    const origin = Date.now();
    log.recordHop({
      id: "req-list-aa",
      startedAt: new Date(origin).toISOString(),
      status: 200,
      model: "glm-5.3-flash",
      providerName: "Zhipu",
    });
    log.recordHop({
      id: "req-list-bb",
      startedAt: new Date(origin + 1000).toISOString(),
      status: 400,
      model: "deepseek-v4-flash",
      error: "missing field tool_call_id",
      providerName: "DeepSeek",
    });
    const errors = log.listRequests({ ok: false });
    assert.equal(errors.total, 1);
    assert.equal(errors.items[0]?.model, "deepseek-v4-flash");
    const search = log.listRequests({ q: "tool_call_id" });
    assert.equal(search.total, 1);
    const byModel = log.listRequests({ model: "glm-5.3-flash" });
    assert.equal(byModel.total, 1);
  });
});

test("default-off hop POST does not create a jsonl file", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-hop-log-"));
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  });
  const hop = await startHop({
    dir,
    plan: planFor(`http://127.0.0.1:${String(upstream.port)}/v1`),
    secrets: { providers: { deepseek: "sk-test-log-secret" } },
  });
  try {
    const out = await post(hop.port, { model: "deepseek-v4-flash", messages: [] });
    assert.equal(out.status, 200);
    assert.equal(existsSync(path.join(dir, "openbot-requests.jsonl")), false);
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});

test("enabled hop POST writes metadata and never stores the secret", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-hop-log-"));
  writeFileSync(
    path.join(dir, "openbot-logs.json"),
    JSON.stringify({
      loggingEnabled: true,
      logBodies: true,
      logBodiesOnError: true,
      logRetentionDays: 7,
      maxBodyCaptureBytes: 65536,
      maxRecords: 200,
    }),
  );
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
      }),
    );
  });
  const hop = await startHop({
    dir,
    plan: planFor(`http://127.0.0.1:${String(upstream.port)}/v1`),
    secrets: { providers: { deepseek: "sk-test-log-secret" } },
  });
  try {
    const out = await post(hop.port, { model: "deepseek-v4-flash", messages: [] });
    assert.equal(out.status, 200);
    const jsonl = readFileSync(path.join(dir, "openbot-requests.jsonl"), "utf8");
    assert.match(jsonl, /deepseek-v4-flash/);
    assert.match(jsonl, /"ok":true/);
    const dump = scanDir(dir);
    assert.equal(dump.includes("sk-test-log-secret"), false);
    assert.equal(dump.includes("Bearer sk-test-log-secret"), false);
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});

test("enabled hop records upstream 400 JSON error text", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-hop-log-"));
  writeFileSync(
    path.join(dir, "openbot-logs.json"),
    JSON.stringify({
      loggingEnabled: true,
      logBodies: false,
      logBodiesOnError: true,
      logRetentionDays: 7,
      maxBodyCaptureBytes: 65536,
      maxRecords: 200,
    }),
  );
  const upstream = await listen((_req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "missing field tool_call_id" } }));
  });
  const hop = await startHop({
    dir,
    plan: planFor(`http://127.0.0.1:${String(upstream.port)}/v1`),
    secrets: { providers: { deepseek: "sk-test-log-secret" } },
  });
  try {
    const out = await post(hop.port, { model: "deepseek-v4-flash", messages: [] });
    assert.equal(out.status, 400);
    const row = JSON.parse(readFileSync(path.join(dir, "openbot-requests.jsonl"), "utf8").trim()) as {
      ok: boolean;
      error?: string;
      hasResponse?: boolean;
    };
    assert.equal(row.ok, false);
    assert.equal(row.error, "missing field tool_call_id");
    assert.equal(row.hasResponse, true);
    const dump = scanDir(dir);
    assert.equal(dump.includes("sk-test-log-secret"), false);
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});
