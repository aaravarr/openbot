import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hopServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/hop-server.cjs");

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

function post(
  port: number,
  body: unknown,
  headers: Record<string, string>,
  pathname = "/v1/chat/completions",
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
          ...headers,
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
  plan: unknown;
  secrets: unknown;
}): Promise<{ port: number; child: ChildProcess }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-hop-"));
  const planPath = path.join(dir, "plan.json");
  const secretsPath = path.join(dir, "secrets.json");
  writeFileSync(planPath, JSON.stringify(input.plan));
  writeFileSync(secretsPath, JSON.stringify(input.secrets));
  const port = await freePort();
  const child = spawn(process.execPath, [hopServer], {
    env: {
      ...process.env,
      OPENBOT_HOP_HOST: "127.0.0.1",
      OPENBOT_HOP_PORT: String(port),
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

async function captureUpstream(): Promise<{
  server: http.Server;
  port: number;
  getAuth: () => string;
  getBody: () => Record<string, unknown> | undefined;
}> {
  let auth = "";
  let body: Record<string, unknown> | undefined;
  const { server, port } = await listen((req, res) => {
    const header = req.headers.authorization;
    auth = typeof header === "string" ? header : "";
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
      );
    });
  });
  return { server, port, getAuth: () => auth, getBody: () => body };
}

test("hop strips client Authorization and injects the secret store key", async () => {
  const upstream = await captureUpstream();
  const hop = await startHop({
    plan: {
      kind: "custom",
      catalog: {
        providers: [
          {
            id: "zhipu",
            name: "Zhipu",
            origin: `http://127.0.0.1:${String(upstream.port)}/v1`,
            maxTokensDefault: 65536,
            mapFile: "provider-maps.cjs",
          },
        ],
        models: [{ id: "zhipu:glm", providerId: "zhipu", slug: "glm-5.3-flash", parameters: [] }],
        bindings: [],
      },
    },
    secrets: { providers: { zhipu: "sk-real" } },
  });
  try {
    const out = await post(hop.port, { model: "glm-5.3-flash", messages: [] }, { Authorization: "Bearer openbot-runtime" });
    assert.equal(out.status, 200);
    assert.equal(upstream.getAuth(), "Bearer sk-real");
    assert.notEqual(upstream.getAuth(), "Bearer openbot-runtime");
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});

test("hop prefers the wildcard-bound provider when two models share a slug", async () => {
  const upstream = await captureUpstream();
  const origin = `http://127.0.0.1:${String(upstream.port)}/v1`;
  const hop = await startHop({
    plan: {
      kind: "custom",
      agents: { "*": { modelId: "shared-slug", providerId: "openai" } },
      catalog: {
        providers: [
          { id: "zhipu", name: "Zhipu", origin, maxTokensDefault: 65536, mapFile: "provider-maps.cjs" },
          { id: "openai", name: "OpenAI", origin, maxTokensDefault: 65536, mapFile: "provider-maps.cjs" },
        ],
        models: [
          { id: "zhipu:shared-slug", providerId: "zhipu", slug: "shared-slug", parameters: [] },
          { id: "openai:shared-slug", providerId: "openai", slug: "shared-slug", parameters: [] },
        ],
        bindings: [],
      },
    },
    secrets: { providers: { zhipu: "sk-zhipu", openai: "sk-openai" } },
  });
  try {
    const out = await post(hop.port, { model: "shared-slug", messages: [] }, { Authorization: "Bearer openbot-runtime" });
    assert.equal(out.status, 200);
    assert.equal(upstream.getAuth(), "Bearer sk-openai");
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});

test("hop caps max_tokens and maps active reasoning to reasoning_effort", async () => {
  const upstream = await captureUpstream();
  const hop = await startHop({
    plan: {
      kind: "custom",
      catalog: {
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            origin: `http://127.0.0.1:${String(upstream.port)}/v1`,
            maxTokensDefault: 65536,
            mapFile: "provider-maps.cjs",
          },
        ],
        models: [
          {
            id: "openai:gpt-4.1",
            providerId: "openai",
            slug: "gpt-4.1",
            maxOutputTokens: 4096,
            activeReasoning: "high",
            parameters: [],
          },
        ],
        bindings: [],
      },
    },
    secrets: { providers: { openai: "sk-openai" } },
  });
  try {
    const out = await post(
      hop.port,
      { model: "gpt-4.1", messages: [], max_tokens: 99999 },
      { Authorization: "Bearer openbot-runtime" },
    );
    assert.equal(out.status, 200);
    const body = upstream.getBody();
    assert.equal(body?.model, "gpt-4.1");
    assert.equal(body?.max_tokens, 4096);
    assert.equal(body?.reasoning_effort, "high");
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});

test("hop leaves GLM thinking unset when old catalog none means default", async () => {
  const upstream = await captureUpstream();
  const hop = await startHop({
    plan: {
      kind: "custom",
      catalog: {
        providers: [
          {
            id: "zhipu",
            name: "Zhipu",
            origin: `http://127.0.0.1:${String(upstream.port)}/v1`,
            maxTokensDefault: 65536,
            mapFile: "provider-maps.cjs",
          },
        ],
        models: [
          {
            id: "zhipu:glm",
            providerId: "zhipu",
            slug: "glm-5.3-flash",
            activeReasoning: "none",
            parameters: [],
          },
        ],
        bindings: [],
      },
    },
    secrets: { providers: { zhipu: "sk-real" } },
  });
  try {
    const out = await post(hop.port, { model: "glm-5.3-flash", messages: [] }, { Authorization: "Bearer openbot-runtime" });
    assert.equal(out.status, 200);
    const body = upstream.getBody();
    assert.equal(body?.thinking, undefined);
    assert.equal(body?.reasoning_effort, undefined);
    assert.equal(body?.max_tokens, 65536);
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});


test("hop sends GLM thinking disabled when Off is chosen after default exists", async () => {
  const upstream = await captureUpstream();
  const hop = await startHop({
    plan: {
      kind: "custom",
      catalog: {
        providers: [
          {
            id: "zhipu",
            name: "Zhipu",
            origin: `http://127.0.0.1:${String(upstream.port)}/v1`,
            maxTokensDefault: 65536,
            mapFile: "provider-maps.cjs",
          },
        ],
        models: [
          {
            id: "zhipu:glm",
            providerId: "zhipu",
            slug: "glm-5.3-flash",
            reasoningLevels: ["default", "none", "low", "high"],
            activeReasoning: "none",
            parameters: [],
          },
        ],
        bindings: [],
      },
    },
    secrets: { providers: { zhipu: "sk-real" } },
  });
  try {
    const out = await post(hop.port, { model: "glm-5.3-flash", messages: [] }, { Authorization: "Bearer openbot-runtime" });
    assert.equal(out.status, 200);
    const body = upstream.getBody();
    assert.deepEqual(body?.thinking, { type: "disabled" });
    assert.equal(body?.reasoning_effort, undefined);
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});

test("hop does not serve /v1/responses or /v1/messages", async () => {
  const hop = await startHop({
    plan: { kind: "custom", catalog: { providers: [], models: [], bindings: [] } },
    secrets: { providers: {} },
  });
  try {
    const responses = await post(hop.port, { model: "gpt-4.1" }, {}, "/v1/responses");
    const messages = await post(hop.port, { model: "claude" }, {}, "/v1/messages");
    assert.equal(responses.status, 404);
    assert.equal(messages.status, 404);
  } finally {
    hop.child.kill("SIGTERM");
  }
});

test("hop fills tool_call_id on tool messages before the upstream", async () => {
  const upstream = await captureUpstream();
  const hop = await startHop({
    plan: {
      kind: "custom",
      catalog: {
        providers: [
          {
            id: "deepseek",
            name: "DeepSeek",
            origin: `http://127.0.0.1:${String(upstream.port)}/v1`,
            maxTokensDefault: 65536,
            mapFile: "provider-maps.cjs",
          },
        ],
        models: [{ id: "deepseek:v4", providerId: "deepseek", slug: "deepseek-v4-flash", parameters: [] }],
        bindings: [],
      },
    },
    secrets: { providers: { deepseek: "sk-deepseek" } },
  });
  try {
    const out = await post(
      hop.port,
      {
        model: "deepseek-v4-flash",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_abc", type: "function", function: { name: "Read", arguments: "{}" } }],
          },
          { role: "tool", content: '{"file":"huge"}' },
          {
            role: "assistant",
            content: [
              { type: "text", text: "next" },
              { type: "tool-call", toolCallId: "call_def", toolName: "Grep", args: { q: "x" } },
            ],
          },
          {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "call_def", result: { hits: 1 } }],
          },
        ],
      },
      { Authorization: "Bearer openbot-runtime" },
    );
    assert.equal(out.status, 200);
    const body = upstream.getBody();
    const messages = body?.messages as { role: string; tool_call_id?: string; tool_calls?: { id: string }[] }[];
    assert.equal(messages[2]?.role, "tool");
    assert.equal(messages[2]?.tool_call_id, "call_abc");
    assert.equal(messages[4]?.role, "tool");
    assert.equal(messages[4]?.tool_call_id, "call_def");
    assert.equal(messages[3]?.tool_calls?.[0]?.id, "call_def");
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});

