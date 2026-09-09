import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hopServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/hop-server.cjs");
const botId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const botMessages = [
  { role: "system", content: "Profile: /home/box/agent-data/agents/" + botId + "/profile.json" },
  { role: "user", content: "hello" },
];

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

function post(port: number, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(payload.length) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function captureUpstream(): Promise<{
  server: http.Server;
  port: number;
  getBody: () => Record<string, unknown> | undefined;
}> {
  let body: Record<string, unknown> | undefined;
  const { server, port } = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
  });
  return { server, port, getBody: () => body };
}

async function freePort(): Promise<number> {
  const probe = await listen(() => undefined);
  const port = probe.port;
  probe.server.close();
  return port;
}

async function startHop(input: {
  upstreamPort: number;
  assignments: Record<string, string>;
}): Promise<{ port: number; child: ChildProcess }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-hop-bot-models-"));
  const origin = "http://127.0.0.1:" + String(input.upstreamPort) + "/v1";
  writeFileSync(
    path.join(dir, "plan.json"),
    JSON.stringify({
      kind: "custom",
      agents: { "*": { modelId: "glm-5.3-flash", providerId: "zhipu" } },
      catalog: {
        providers: [{ id: "zhipu", name: "Zhipu", origin, maxTokensDefault: 65536, mapFile: "provider-maps.cjs" }],
        models: [
          { id: "zhipu:glm-5.3-flash", providerId: "zhipu", slug: "glm-5.3-flash", parameters: [] },
          { id: "zhipu:glm-5.3", providerId: "zhipu", slug: "glm-5.3", parameters: [] },
        ],
        bindings: [],
      },
    }),
  );
  writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ providers: { zhipu: "sk-test" } }));
  writeFileSync(path.join(dir, "assignments.json"), JSON.stringify({ assignments: input.assignments }));
  const port = await freePort();
  const child = spawn(process.execPath, [hopServer], {
    env: {
      ...process.env,
      OPENBOT_HOP_HOST: "127.0.0.1",
      OPENBOT_HOP_PORT: String(port),
      OPENBOT_SAND_DATA: dir,
      OPENBOT_LOGS: path.join(dir, "openbot-logs.json"),
      OPENBOT_PLAN: path.join(dir, "plan.json"),
      OPENBOT_SECRETS: path.join(dir, "secrets.json"),
      OPENBOT_BOT_MODELS: path.join(dir, "assignments.json"),
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

async function withHop(
  assignments: Record<string, string>,
  run: (hop: { port: number }, upstream: { getBody: () => Record<string, unknown> | undefined }) => Promise<void>,
): Promise<void> {
  const upstream = await captureUpstream();
  const hop = await startHop({ upstreamPort: upstream.port, assignments });
  try {
    await run(hop, upstream);
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
}

test("handleCompletions overrides the model when the bot has an assignment", async () => {
  await withHop({ [botId]: "zhipu:glm-5.3" }, async (hop, upstream) => {
    const out = await post(hop.port, { model: "glm-5.3-flash", messages: botMessages });
    assert.equal(out.status, 200);
    assert.equal(upstream.getBody()?.model, "glm-5.3");
  });
});

test("handleCompletions keeps the caller model when the bot has no assignment", async () => {
  await withHop({}, async (hop, upstream) => {
    const out = await post(hop.port, { model: "glm-5.3-flash", messages: botMessages });
    assert.equal(out.status, 200);
    assert.equal(upstream.getBody()?.model, "glm-5.3-flash");
  });
});

test("handleCompletions falls back to the caller model when the assignment is stale", async () => {
  await withHop({ [botId]: "zhipu:deleted-model" }, async (hop, upstream) => {
    const out = await post(hop.port, { model: "glm-5.3-flash", messages: botMessages });
    assert.equal(out.status, 200);
    assert.equal(upstream.getBody()?.model, "glm-5.3-flash");
  });
});

test("handleCompletions falls back to the wildcard when the body already carries the stale assignment", async () => {
  await withHop({ [botId]: "zhipu:deleted-model" }, async (hop, upstream) => {
    const out = await post(hop.port, { model: "zhipu:deleted-model", messages: botMessages });
    assert.equal(out.status, 200);
    assert.equal(upstream.getBody()?.model, "glm-5.3-flash");
  });
});
