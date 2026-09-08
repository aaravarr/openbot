import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { sanitizeToolCallIds, repairToolCallIds, toOpenAIMessages } = require(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/openai-messages.cjs"),
) as {
  sanitizeToolCallIds: (msgs: unknown) => unknown;
  repairToolCallIds: (msgs: unknown) => unknown;
  toOpenAIMessages: (msgs: unknown) => {
    role: string;
    content: string;
    tool_call_id?: string;
    tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  }[];
};

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const unsafeLongId = "call_" + "x".repeat(100);

type Msg = {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }[];
};

test("sanitizeToolCallIds truncates a long id and keeps the pairing", () => {
  const msgs: Msg[] = [
    { role: "assistant", content: "", tool_calls: [{ id: unsafeLongId, type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: unsafeLongId, content: "ok" },
  ];
  const out = sanitizeToolCallIds(msgs) as Msg[];
  const newId = out[0]?.tool_calls?.[0]?.id ?? "";
  assert.ok(newId.length <= 64, "id length " + String(newId.length));
  assert.ok(SAFE_ID_RE.test(newId), "unsafe charset " + newId);
  assert.equal(out[1]?.tool_call_id, newId);
});

test("sanitizeToolCallIds maps the same original id consistently across occurrences", () => {
  const msgs: Msg[] = [
    { role: "assistant", content: "", tool_calls: [
      { id: unsafeLongId, type: "function", function: { name: "A", arguments: "{}" } },
      { id: unsafeLongId, type: "function", function: { name: "B", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: unsafeLongId, content: "ok1" },
    { role: "tool", tool_call_id: unsafeLongId, content: "ok2" },
  ];
  const out = sanitizeToolCallIds(msgs) as Msg[];
  const a = out[0]?.tool_calls?.[0]?.id ?? "";
  const b = out[0]?.tool_calls?.[1]?.id ?? "";
  assert.equal(a, b);
  assert.equal(out[1]?.tool_call_id, a);
  assert.equal(out[2]?.tool_call_id, a);
});

test("sanitizeToolCallIds is stable across two separate calls", () => {
  const msgs: Msg[] = [
    { role: "assistant", content: "", tool_calls: [{ id: unsafeLongId, type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: unsafeLongId, content: "ok" },
  ];
  const first = (sanitizeToolCallIds(JSON.parse(JSON.stringify(msgs))) as Msg[])[0]?.tool_calls?.[0]?.id ?? "";
  const second = (sanitizeToolCallIds(JSON.parse(JSON.stringify(msgs))) as Msg[])[0]?.tool_calls?.[0]?.id ?? "";
  assert.equal(first, second);
});

test("sanitizeToolCallIds leaves short safe ids unchanged", () => {
  const short = "call_short_1";
  const msgs: Msg[] = [
    { role: "assistant", content: "", tool_calls: [{ id: short, type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: short, content: "ok" },
  ];
  const out = sanitizeToolCallIds(msgs) as Msg[];
  assert.equal(out[0]?.tool_calls?.[0]?.id, short);
  assert.equal(out[1]?.tool_call_id, short);
});

test("sanitizeToolCallIds sanitizes ids with unsafe characters and keeps pairing", () => {
  const dirty = "call id with spaces/plus+plus";
  const msgs: Msg[] = [
    { role: "assistant", content: "", tool_calls: [{ id: dirty, type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: dirty, content: "ok" },
  ];
  const out = sanitizeToolCallIds(msgs) as Msg[];
  const newId = out[0]?.tool_calls?.[0]?.id ?? "";
  assert.ok(newId.length <= 64);
  assert.ok(SAFE_ID_RE.test(newId));
  assert.equal(out[1]?.tool_call_id, newId);
});

test("sanitizeToolCallIds does not throw on missing/non-string ids", () => {
  const msgs = [
    { role: "assistant", content: "", tool_calls: [{ id: null, type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", content: "ok" },
    null,
    undefined,
    "not-a-record",
  ];
  const out = sanitizeToolCallIds(msgs) as Msg[];
  assert.equal(out[0]?.tool_calls?.[0]?.id, null);
  assert.equal(out[1]?.tool_call_id, undefined);
});

test("sanitizeToolCallIds runs after repairToolCallIds and keeps the final pairing", () => {
  const longFirst = "call_" + "a".repeat(80);
  const longSecond = "call_" + "b".repeat(80);
  const msgs: Msg[] = [
    { role: "assistant", content: "", tool_calls: [{ id: longFirst, type: "function", function: { name: "A", arguments: "{}" } }] },
    { role: "assistant", content: "", tool_calls: [{ id: longSecond, type: "function", function: { name: "B", arguments: "{}" } }] },
    { role: "tool", tool_call_id: longFirst, content: "ok1" },
    { role: "tool", content: "ok2" },
  ];
  const repaired = repairToolCallIds(msgs) as Msg[];
  const sanitized = sanitizeToolCallIds(repaired) as Msg[];
  assert.equal(sanitized[2]?.tool_call_id, sanitized[0]?.tool_calls?.[0]?.id);
  assert.equal(sanitized[3]?.tool_call_id, sanitized[1]?.tool_calls?.[0]?.id);
  assert.ok((sanitized[0]?.tool_calls?.[0]?.id ?? "").length <= 64);
  assert.ok((sanitized[1]?.tool_calls?.[0]?.id ?? "").length <= 64);
});

test("toOpenAIMessages applies sanitization to its final output", () => {
  const msgs: Msg[] = [
    { role: "assistant", content: "", tool_calls: [{ id: unsafeLongId, type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: unsafeLongId, content: "ok" },
  ];
  const out = toOpenAIMessages(msgs);
  const newId = out[0]?.tool_calls?.[0]?.id ?? "";
  assert.ok(newId.length <= 64);
  assert.equal(out[1]?.tool_call_id, newId);
});

// End-to-end hop path

const hopServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/hop-server.cjs");

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

function post(
  port: number,
  body: unknown,
  headers: Record<string, string>,
  pathname = "/v1/chat/completions",
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(payload.length), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
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

async function startHop(input: { plan: unknown; secrets: unknown }): Promise<{ port: number; child: ChildProcess }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-hop-id-"));
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

function collectAllIds(messages: { role?: string; tool_calls?: { id?: string }[]; tool_call_id?: string }[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        if (typeof c?.id === "string") ids.push(c.id);
      }
    }
    if (m?.role === "tool" && typeof m.tool_call_id === "string") ids.push(m.tool_call_id);
  }
  return ids;
}

test("hop sanitizes every outbound tool call id to <= 64 chars", async () => {
  let captured: Record<string, unknown> | undefined;
  const upstream = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
  });
  const origin = "http://127.0.0.1:" + String(upstream.port) + "/v1";
  const hop = await startHop({
    plan: {
      kind: "custom",
      catalog: {
        providers: [
          { id: "p", name: "Provider", origin, maxTokensDefault: 65536, mapFile: "provider-maps.cjs" },
        ],
        models: [{ id: "p:m", providerId: "p", slug: "m", parameters: [] }],
        bindings: [],
      },
    },
    secrets: { providers: { p: "sk" } },
  });
  try {
    const assistant = { role: "assistant", content: "", tool_calls: [{ id: unsafeLongId, type: "function", function: { name: "Read", arguments: "{}" } }] };
    const tool = { role: "tool", tool_call_id: unsafeLongId, content: "ok" };
    const out = await post(hop.port, { model: "m", messages: [assistant, tool] }, { Authorization: "Bearer runtime" });
    assert.equal(out.status, 200);
    assert.ok(captured, "upstream body captured");
    const messages = (captured as { messages?: { role?: string; tool_calls?: { id?: string }[]; tool_call_id?: string }[] }).messages ?? [];
    assert.ok(Array.isArray(messages));
    const ids = collectAllIds(messages);
    assert.ok(ids.length >= 2, "expected at least 2 ids");
    for (const id of ids) {
      assert.ok(id.length <= 64, "outbound id too long: " + id);
      assert.ok(SAFE_ID_RE.test(id), "outbound id unsafe: " + id);
    }
    const callId = messages[1]?.tool_calls?.[0]?.id;
    assert.equal(messages[2]?.tool_call_id, callId);
  } finally {
    hop.child.kill("SIGTERM");
    upstream.server.close();
  }
});
