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

function post(port: number, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: unknown }> {
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

test("hop strips client Authorization and injects the secret store key", async () => {
  let seenAuth = "";
  const upstream = await listen((req, res) => {
    const header = req.headers.authorization;
    seenAuth = typeof header === "string" ? header : "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    );
  });
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
    assert.equal(seenAuth, "Bearer sk-real");
    assert.notEqual(seenAuth, "Bearer openbot-runtime");
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});

test("hop prefers the wildcard-bound provider when two models share a slug", async () => {
  let seenAuth = "";
  const upstream = await listen((req, res) => {
    const header = req.headers.authorization;
    seenAuth = typeof header === "string" ? header : "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    );
  });
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
    assert.equal(seenAuth, "Bearer sk-openai");
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});
