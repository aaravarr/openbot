import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const messagesLib = require(path.join(here, "../../payload/openai-messages.cjs")) as {
  toOpenAIMessages: (msgs: unknown) => { role: string; content: unknown; tool_call_id?: string; tool_calls?: { id: string }[] }[];
  dropEmptyAssistantMessages: (msgs: unknown) => { role: string; content: unknown; tool_calls?: { id: string }[] }[];
};
const hopLib = require(path.join(here, "../../payload/hop-handler.cjs")) as {
  applyMaxTokens: (body: { max_tokens?: unknown }, model: { maxOutputTokens?: unknown } | undefined) => void;
};

// Global safety ceiling, mirrors MAX_OUTPUT_TOKENS_CEILING.
const CEILING = 131072;

test("applyMaxTokens truncates a poisoned catalog cap (943718) to the ceiling", () => {
  const body = { max_tokens: 943718 };
  hopLib.applyMaxTokens(body, { maxOutputTokens: 943718 });
  assert.equal(body.max_tokens, CEILING);
});

test("applyMaxTokens truncates an oversized request to the model cap", () => {
  const body = { max_tokens: 99999 };
  hopLib.applyMaxTokens(body, { maxOutputTokens: 4096 });
  assert.equal(body.max_tokens, 4096);
});

test("applyMaxTokens keeps a small request under a sane cap", () => {
  const body = { max_tokens: 1024 };
  hopLib.applyMaxTokens(body, { maxOutputTokens: 4096 });
  assert.equal(body.max_tokens, 1024);
});

test("applyMaxTokens falls back to the default when the catalog cap is missing", () => {
  const body = { max_tokens: 999999 };
  hopLib.applyMaxTokens(body, {});
  assert.equal(body.max_tokens, 65536);
});

test("applyMaxTokens fills a missing max_tokens from the model cap", () => {
  const body: { max_tokens?: unknown } = {};
  hopLib.applyMaxTokens(body, { maxOutputTokens: 4096 });
  assert.equal(body.max_tokens, 4096);
});

test("applyMaxTokens clamps a sane-but-huge cap to the ceiling on fill", () => {
  const body: { max_tokens?: unknown } = {};
  hopLib.applyMaxTokens(body, { maxOutputTokens: 943718 });
  assert.equal(body.max_tokens, CEILING);
});

test("dropEmptyAssistantMessages removes empty assistants without tool calls", () => {
  const out = messagesLib.dropEmptyAssistantMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: "" },
    { role: "assistant", content: null },
    { role: "assistant", content: "real" },
    { role: "user", content: "again" },
  ]);
  assert.deepEqual(
    out.map((m) => [m.role, m.content]),
    [
      ["user", "hi"],
      ["assistant", "real"],
      ["user", "again"],
    ],
  );
});

test("dropEmptyAssistantMessages keeps empty-content assistants WITH tool calls", () => {
  const turn = {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: "{}" } }],
  };
  const tool = { role: "tool", tool_call_id: "c1", content: "ok" };
  const out = messagesLib.dropEmptyAssistantMessages([turn, tool]);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.tool_calls?.length, 1);
});

test("toOpenAIMessages drops ghost assistants but keeps tool-pairing intact", () => {
  const out = messagesLib.toOpenAIMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: "" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "assistant", content: null },
    { role: "user", content: "done?" },
  ]);
  const ghosts = out.filter((m) => m.role === "assistant" && (m.content === "" || m.content == null) && (m.tool_calls?.length ?? 0) === 0);
  assert.equal(ghosts.length, 0, "no ghost assistant may remain: " + JSON.stringify(out.map((m) => [m.role, m.content])));
  const call = out.find((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0);
  assert.ok(call, "tool-call turn must survive");
  assert.equal(call?.content, "");
  assert.equal(out.find((m) => m.role === "tool")?.tool_call_id, call?.tool_calls?.[0]?.id);
});

// --- End to end through a live hop -----------------------------------------

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

function post(port: number, body: unknown): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(payload.length), Authorization: "Bearer runtime" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function startHop(plan: unknown, secrets: unknown): Promise<{ port: number; child: ChildProcess }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-hop-gov-"));
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  writeFileSync(path.join(dir, "secrets.json"), JSON.stringify(secrets));
  const hop = await listen(() => undefined);
  const port = hop.port;
  hop.server.close();
  const child = spawn(process.execPath, [path.join(here, "../../payload/hop-server.cjs")], {
    env: {
      ...process.env,
      OPENBOT_HOP_HOST: "127.0.0.1",
      OPENBOT_HOP_PORT: String(port),
      OPENBOT_SAND_DATA: dir,
      OPENBOT_LOGS: path.join(dir, "openbot-logs.json"),
      OPENBOT_PLAN: path.join(dir, "plan.json"),
      OPENBOT_SECRETS: path.join(dir, "secrets.json"),
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

test("hop end to end: poisoned cap truncated, ghost assistants stripped", async () => {
  let captured: { max_tokens?: unknown; messages?: { role?: string; content?: unknown }[] } | undefined;
  const upstream = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof captured;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
  });
  const origin = "http://127.0.0.1:" + String(upstream.port) + "/v1";
  const hop = await startHop(
    {
      kind: "custom",
      catalog: {
        providers: [{ id: "p", name: "P", origin, maxTokensDefault: 65536, mapFile: "provider-maps.cjs" }],
        models: [{ id: "p:m", providerId: "p", slug: "m", maxOutputTokens: 943718, parameters: [] }],
        bindings: [],
      },
    },
    { providers: { p: "sk" } },
  );
  try {
    // Minimal repro cut from the 2026-09-07 failed request: an empty
    // assistant stranded between user turns, plus the poisoned max_tokens.
    const out = await post(hop.port, {
      model: "m",
      stream: false,
      max_tokens: 943718,
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "user", content: "follow-up" },
      ],
    });
    assert.equal(out.status, 200);
    assert.ok(captured, "upstream body captured");
    assert.equal(captured?.max_tokens, CEILING);
    const ghosts = (captured?.messages ?? []).filter((m) => m.role === "assistant" && (m.content === "" || m.content == null));
    // The only remaining empty-content assistant is the tool-call turn.
    assert.ok(
      ghosts.every((m) => (m as { tool_calls?: unknown[] }).tool_calls !== undefined),
      "ghost assistants must be stripped: " + JSON.stringify((captured?.messages ?? []).map((m) => [m.role, m.content])),
    );
    assert.equal(ghosts.length, 1);
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});
