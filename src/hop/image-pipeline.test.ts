import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
};

// 1x1 transparent PNG (68 bytes).
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

type UpstreamMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  experimental_content?: unknown;
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-image-pipeline-"));
  writeFileSync(
    path.join(dir, "plan.json"),
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
  writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ providers: { zhipu: "sk-real" } }));
  writeFileSync(
    path.join(dir, "openbot-logs.json"),
    JSON.stringify({ loggingEnabled: false }),
  );

  const prev = {
    plan: process.env.OPENBOT_PLAN,
    secrets: process.env.OPENBOT_SECRETS,
    sand: process.env.OPENBOT_SAND_DATA,
    logs: process.env.OPENBOT_LOGS,
  };
  process.env.OPENBOT_PLAN = path.join(dir, "plan.json");
  process.env.OPENBOT_SECRETS = path.join(dir, "secrets.json");
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

function postJson(port: number, body: unknown): Promise<{ status: number; json: unknown }> {
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

test("experimental_content image bytes reach the upstream body once and the carried field is stripped", async () => {
  let captured: { messages?: UpstreamMessage[] } | undefined;
  const upstream = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.resume();
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: UpstreamMessage[] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
  });
  try {
    await withHopEnv(`http://127.0.0.1:${String(upstream.port)}/v1`, async () => {
      const hopServer = await startHopServer();
      try {
        // Runtime-style body: the runtime's first toOpenAIMessages pass already
        // converted host parts; the tool row carries experimental_content.
        const out = await postJson(hopServer.port, {
          model: "glm-5.3-flash",
          messages: [
            { role: "user", content: "look at the screenshot" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "Read", arguments: JSON.stringify({ path: "Z:\\missing\\shot.png" }) },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "call_1",
              content: "Read image file",
              experimental_content: { type: "image", data: PNG_BASE64, mimeType: "image/png" },
            },
          ],
        });
        assert.equal(out.status, 200);
        const messages = captured?.messages ?? [];
        assert.equal(messages.length, 4);
        assert.equal(messages[2]?.role, "tool");
        assert.equal(messages[3]?.role, "user");
        const parts = messages[3]?.content as { type: string; text?: string; image_url?: { url: string } }[];
        assert.equal(parts[0]?.text, "[Image attached from Read: Z:\\missing\\shot.png]");
        assert.equal(parts[1]?.image_url?.url, PNG_DATA_URL);
        const serialized = JSON.stringify(captured);
        assert.equal(serialized.includes("experimental_content"), false);
        assert.equal(serialized.includes("experimentalContent"), false);
      } finally {
        hopServer.server.close();
      }
    });
  } finally {
    upstream.server.close();
  }
});

test("host attachment image parts become image_url content on the hop path", async () => {
  let captured: { messages?: UpstreamMessage[] } | undefined;
  const upstream = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.resume();
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: UpstreamMessage[] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
  });
  try {
    await withHopEnv(`http://127.0.0.1:${String(upstream.port)}/v1`, async () => {
      const hopServer = await startHopServer();
      try {
        const out = await postJson(hopServer.port, {
          model: "glm-5.3-flash",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "see this" },
                { type: "image", image: PNG_BASE64, mimeType: "image/png" },
              ],
            },
          ],
        });
        assert.equal(out.status, 200);
        const messages = captured?.messages ?? [];
        assert.equal(messages.length, 1);
        const parts = messages[0]?.content as { type: string; text?: string; image_url?: { url: string } }[];
        assert.equal(parts[0]?.text, "see this");
        assert.equal(parts[1]?.image_url?.url, PNG_DATA_URL);
      } finally {
        hopServer.server.close();
      }
    });
  } finally {
    upstream.server.close();
  }
});
