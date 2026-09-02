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

async function freePort(): Promise<number> {
  const hop = await listen(() => undefined);
  const port = hop.port;
  hop.server.close();
  return port;
}

async function startHop(input: { plan: unknown; secrets: unknown }): Promise<{ port: number; child: ChildProcess }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-hop-sse-"));
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
      OPENBOT_SAND_DATA: dir,
      OPENBOT_LOGS: path.join(dir, "openbot-logs.json"),
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

function glmPlan(origin: string) {
  return {
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
  };
}

test("hop forwards stream true and pipes SSE before upstream ends", async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  const upstream = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"early\"}}]}\n\n");
      setTimeout(() => {
        res.write("data: [DONE]\n\n");
        res.end();
      }, 500);
    });
  });
  const hop = await startHop({
    plan: glmPlan(`http://127.0.0.1:${String(upstream.port)}/v1`),
    secrets: { providers: { zhipu: "sk-real" } },
  });
  try {
    const payload = Buffer.from(JSON.stringify({
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }));
    const started = Date.now();
    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no SSE chunk")), 2000);
      const req = http.request(
        {
          host: "127.0.0.1",
          port: hop.port,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(payload.length),
            Authorization: "Bearer openbot-runtime",
          },
        },
        (res) => {
          assert.equal(String(res.headers["content-type"] || "").includes("event-stream"), true);
          res.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            if (text.includes("early")) {
              clearTimeout(timer);
              resolve(text);
            }
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    assert.match(first, /early/);
    assert.equal(Date.now() - started < 400, true);
    assert.equal(upstreamBody?.stream, true);
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});

test("hop still buffers JSON when stream true comes back as application/json", async () => {
  const upstream = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
  });
  const hop = await startHop({
    plan: glmPlan(`http://127.0.0.1:${String(upstream.port)}/v1`),
    secrets: { providers: { zhipu: "sk-real" } },
  });
  try {
    const payload = Buffer.from(JSON.stringify({
      model: "glm-5.3-flash",
      messages: [],
      stream: true,
    }));
    const out = await new Promise<{ status: number; json: { choices: { message: { content: string } }[] } }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: hop.port,
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
            resolve({
              status: res.statusCode ?? 0,
              json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as { choices: { message: { content: string } }[] },
            });
          });
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    assert.equal(out.status, 200);
    assert.equal(out.json.choices[0]?.message.content, "ok");
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});
