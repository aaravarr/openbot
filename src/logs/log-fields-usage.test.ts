import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type UsageResult = {
  approximate: boolean;
  scanned: number;
  total: number;
  from: string;
  to: string;
  byDay: Array<Row>;
  byModel: Array<Row>;
  byProvider: Array<Row>;
};

const log = require("../../payload/request-log.cjs") as {
  loadSettings: () => Record<string, unknown>;
  saveSettings: (input: unknown) => Record<string, unknown>;
  recordHop: (input: unknown) => void;
  listRequests: (query?: unknown) => { items: Row[]; total: number };
  getRequest: (id: string) => Row | null;
  usageNow: (query?: unknown) => UsageResult;
  extractUsage: (payload: unknown) => Row | undefined;
  extractResponseFromSse: (text: unknown) => Row | undefined;
  statsNow: () => Record<string, number | boolean>;
};

const hop = require("../../payload/hop-handler.cjs") as {
  detectClientName: (ua: unknown, headers: unknown) => string;
  parseClientVersion: (ua: unknown) => string;
  findConversationId: (body: unknown) => string;
  noteFirstContent: (state: { buf: string }, chunk: Buffer) => number;
  inboundClientMeta: (req: unknown, body: unknown) => Record<string, string>;
};

const prevEnv = {
  sand: process.env.OPENBOT_SAND_DATA,
  logs: process.env.OPENBOT_LOGS,
  secrets: process.env.OPENBOT_SECRETS,
};

let sandDir = "";

test.beforeEach(() => {
  sandDir = mkdtempSync(path.join(os.tmpdir(), "openbot-logfields-"));
  process.env.OPENBOT_SAND_DATA = sandDir;
  delete process.env.OPENBOT_LOGS;
  process.env.OPENBOT_SECRETS = path.join(sandDir, "secrets.json");
  log.saveSettings(log.loadSettings());
  log.saveSettings({ loggingEnabled: true, logBodies: true });
});

test.after(() => {
  if (prevEnv.sand === undefined) delete process.env.OPENBOT_SAND_DATA;
  else process.env.OPENBOT_SAND_DATA = prevEnv.sand;
  if (prevEnv.logs === undefined) delete process.env.OPENBOT_LOGS;
  else process.env.OPENBOT_LOGS = prevEnv.logs;
  if (prevEnv.secrets === undefined) delete process.env.OPENBOT_SECRETS;
  else process.env.OPENBOT_SECRETS = prevEnv.secrets;
});

function sseBody(frames: unknown[]): string {
  return frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join("") + "data: [DONE]\n\n";
}

test("recordHop ignores maxRecords on the write path", () => {
  log.saveSettings({ maxRecords: 2 });
  const origin = Date.now();
  for (let i = 0; i < 4; i++) {
    log.recordHop({
      id: "nocap-case-" + String(i),
      startedAt: new Date(origin + i * 1000).toISOString(),
      status: 200,
      model: "m",
      requestBody: { model: "m" },
      responseBody: { ok: true },
    });
  }
  assert.equal(log.listRequests().total, 4);
});

test("SSE responseRaw is rebuilt into a readable chat.completion", () => {
  const raw = sseBody([
    { id: "chatcmpl-1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { role: "assistant" } }] },
    { id: "chatcmpl-1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "Hello " } }] },
    { id: "chatcmpl-1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "world" } }] },
    {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
  ]);
  log.recordHop({ id: "sse-case-01", status: 200, model: "m", requestBody: { model: "m" }, responseRaw: raw });
  const row = log.listRequests().items[0] as Row;
  assert.equal(row.hasResponse, true);
  const detail = log.getRequest("sse-case-01") as Row;
  const response = detail.response as { object?: string; choices?: Array<{ message?: { content?: string } }> };
  assert.equal(response.object, "chat.completion");
  assert.equal(response.choices?.[0]?.message?.content, "Hello world");
  assert.equal(row.totalTokens, 7);
});

test("SSE tool_calls deltas aggregate instead of storing a fake-empty body", () => {
  const raw = sseBody([
    {
      id: "chatcmpl-2",
      object: "chat.completion.chunk",
      model: "m",
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get", arguments: '{"a":' } }] } },
      ],
    },
    {
      id: "chatcmpl-2",
      object: "chat.completion.chunk",
      model: "m",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] },
          finish_reason: "tool_calls",
        },
      ],
    },
  ]);
  const rebuilt = log.extractResponseFromSse(raw) as {
    choices: Array<{ message: { content: string; tool_calls: Array<{ function: { arguments: string } }> } }>;
  };
  assert.ok(rebuilt);
  const firstChoice = rebuilt.choices[0];
  assert.ok(firstChoice);
  const message = firstChoice.message;
  assert.equal(message.tool_calls.length, 1);
  const firstCall = message.tool_calls[0];
  assert.ok(firstCall);
  assert.deepEqual(JSON.parse(firstCall.function.arguments), { a: 1 });
});

test("empty responseRaw means no body, not a blank body", () => {
  log.recordHop({
    id: "empty-case-01",
    status: 200,
    model: "m",
    requestBody: { model: "m" },
    responseRaw: "   ",
  });
  const row = log.listRequests().items[0] as Row;
  assert.equal(row.hasRequest, true);
  assert.equal(row.hasResponse, false);
  const detail = log.getRequest("empty-case-01") as Row;
  assert.equal("response" in detail, false);
  assert.equal("bodyMissing" in detail, false);
});

test("missing sidecar file surfaces bodyMissing instead of a blank detail", () => {
  log.recordHop({
    id: "gone-case-01",
    status: 200,
    model: "m",
    requestBody: { model: "m" },
    responseBody: { ok: true },
  });
  rmSync(path.join(sandDir, "openbot-request-bodies", "gone-case-01.json"));
  const detail = log.getRequest("gone-case-01") as Row;
  assert.equal(detail.bodyMissing, true);
});

test("usage dialects: cached and reasoning tokens land on the row", () => {
  log.recordHop({
    id: "tok-1",
    status: 200,
    model: "m",
    requestBody: { model: "m" },
    responseBody: {
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 30 },
        completion_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    },
  });
  const row = log.listRequests().items[0] as Row;
  assert.equal(row.promptTokens, 100);
  assert.equal(row.completionTokens, 20);
  assert.equal(row.totalTokens, 120);
  assert.equal(row.cachedTokens, 30);
  assert.equal(row.reasoningTokens, 12);
  const stats = log.statsNow();
  assert.equal(stats.cachedTokens, 30);
  assert.equal(stats.reasoningTokens, 12);
});

test("Anthropic cache reads fold back into prompt totals", () => {
  const usage = log.extractUsage({ usage: { input_tokens: 50, cache_read_input_tokens: 10 } });
  assert.equal(usage?.promptTokens, 60);
  assert.equal(usage?.cachedTokens, 10);
});

test("SSE multi-usage frames merge field-wise", () => {
  const raw = sseBody([
    { usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 4 } } },
    { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]);
  log.recordHop({ id: "merge-1", status: 200, model: "m", requestBody: { model: "m" }, responseRaw: raw });
  const row = log.listRequests().items[0] as Row;
  assert.equal(row.totalTokens, 15);
  assert.equal(row.reasoningTokens, 4);
});

test("attempts chain is stored with attemptCount", () => {
  log.recordHop({
    id: "att-case-01",
    status: 200,
    model: "m",
    latencyMs: 120,
    requestBody: { model: "m" },
    responseBody: { ok: true },
    attempts: [
      { attempt: 1, status: 503, latencyMs: 40, decision: "retry" },
      { attempt: 2, status: 0, error: "socket hang up", latencyMs: 30, decision: "retry" },
      { attempt: 3, status: 200, latencyMs: 50, decision: "final" },
    ],
  });
  const detail = log.getRequest("att-case-01") as Row;
  assert.equal(detail.attemptCount, 3);
  assert.equal((detail.attempts as Row[]).length, 3);
  const secondAttempt = (detail.attempts as Row[])[1];
  assert.ok(secondAttempt);
  assert.equal(secondAttempt.error, "socket hang up");
  const listed = log.listRequests().items[0] as Row;
  assert.equal(listed.attemptCount, 3);
});

test("attempts sanitize caps at 10 entries", () => {
  const attempts: Row[] = [];
  for (let i = 0; i < 12; i++) attempts.push({ attempt: i + 1, status: 500, latencyMs: 1, decision: "retry" });
  log.recordHop({ id: "att-many", status: 500, model: "m", responseBody: { error: "x" }, attempts });
  const detail = log.getRequest("att-many") as Row;
  assert.equal((detail.attempts as Row[]).length, 10);
  assert.equal(detail.attemptCount, 10);
});

test("client metadata is stored, listed and searchable", () => {
  log.recordHop({
    id: "cli-case-01",
    status: 200,
    model: "m",
    providerId: "p1",
    firstTokenMs: 321,
    clientName: "Cursor",
    clientVersion: "0.42.1",
    userAgent: "Cursor/0.42.1",
    conversationId: "conv-9",
    origin: "10.0.0.2",
    requestId: "req-abc",
    requestBody: { model: "m" },
    responseBody: { ok: true },
  });
  const item = log.listRequests().items[0] as Row;
  assert.equal(item.clientName, "Cursor");
  assert.equal(item.clientVersion, "0.42.1");
  assert.equal(item.userAgent, "Cursor/0.42.1");
  assert.equal(item.conversationId, "conv-9");
  assert.equal(item.origin, "10.0.0.2");
  assert.equal(item.requestId, "req-abc");
  assert.equal(item.firstTokenMs, 321);
  assert.equal(log.listRequests({ q: "cursor" }).total, 1);
  assert.equal(log.listRequests({ q: "conv-9" }).total, 1);
  const detail = log.getRequest("cli-case-01") as Row;
  assert.equal(detail.clientName, "Cursor");
  assert.equal(detail.requestId, "req-abc");
});

test("usageNow groups by day, model and provider with averages", () => {
  const day1 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const day2 = new Date().toISOString();
  const dayKey1 = day1.slice(0, 10);
  const dayKey2 = day2.slice(0, 10);
  log.recordHop({
    id: "use-01", startedAt: day1, status: 200, model: "m-a", providerId: "p1",
    latencyMs: 1000, firstTokenMs: 200,
    requestBody: { model: "m-a" }, responseBody: { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  });
  log.recordHop({
    id: "use-02", startedAt: day1, status: 500, model: "m-a", providerId: "p1",
    latencyMs: 500, requestBody: { model: "m-a" }, responseBody: { error: "boom" },
  });
  log.recordHop({
    id: "use-03", startedAt: day2, status: 200, model: "m-b", providerId: "p2",
    latencyMs: 2000, firstTokenMs: 400,
    requestBody: { model: "m-b" }, responseBody: { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
  });
  const usage = log.usageNow({});
  assert.equal(usage.approximate, false);
  assert.equal(usage.scanned, 3);
  assert.equal(usage.total, 3);
  assert.deepEqual(usage.byDay.map((b) => b.key), [dayKey1, dayKey2]);
  const first = usage.byDay[0];
  assert.ok(first);
  assert.equal(first.requests, 2);
  assert.equal(first.ok, 1);
  assert.equal(first.fail, 1);
  assert.equal(first.promptTokens, 10);
  assert.equal(first.avgLatencyMs, 750);
  assert.equal(first.avgFirstTokenMs, 200);
  const models = Object.fromEntries(usage.byModel.map((b) => [b.key as string, b]));
  assert.equal((models["m-a"] as Row).requests, 2);
  assert.equal((models["m-b"] as Row).totalTokens, 10);
  const providers = Object.fromEntries(usage.byProvider.map((b) => [b.key as string, b]));
  assert.equal((providers["p1"] as Row).requests, 2);
  assert.equal((providers["p2"] as Row).promptTokens, 7);
  const onlyModel = log.usageNow({ model: "m-b" }).byDay[0];
  assert.ok(onlyModel);
  assert.equal((onlyModel as Row).requests, 1);
  assert.equal(log.usageNow({ provider: "p1" }).byModel.length, 1);
  assert.equal(log.usageNow({ from: dayKey2 + "T00:00:00.000Z" }).byDay.length, 1);
});

test("usageNow shares a 60s cache and invalidates on write", () => {
  log.recordHop({ id: "cache-1", status: 200, model: "m", requestBody: { model: "m" }, responseBody: { ok: true } });
  const first = log.usageNow({});
  assert.ok(log.usageNow({}) === first);
  log.recordHop({ id: "cache-2", status: 200, model: "m", requestBody: { model: "m" }, responseBody: { ok: true } });
  const after = log.usageNow({});
  assert.ok(after !== first);
  assert.equal(after.scanned, 2);
});

test("usageNow caps the scan and marks large logs approximate", () => {
  const rows: string[] = [];
  const freshStamp = new Date().toISOString();
  for (let i = 0; i < 5005; i++) {
    rows.push(JSON.stringify({
      id: "bulk-" + String(i), startedAt: freshStamp, completedAt: freshStamp,
      ok: true, status: 200, channel: "hop", inboundEndpoint: "/v1/chat/completions", stream: false,
      hasRequest: false, hasResponse: false, model: "m",
    }));
  }
  writeFileSync(path.join(sandDir, "openbot-requests.jsonl"), rows.join("\n") + "\n");
  log.saveSettings(log.loadSettings());
  const usage = log.usageNow({});
  assert.equal(usage.total, 5005);
  assert.equal(usage.scanned, 5000);
  assert.equal(usage.approximate, true);
});

test("hop client helpers parse UA, version and conversation keys", () => {
  assert.equal(hop.detectClientName("Cursor/0.42.1", {}), "Cursor");
  assert.equal(hop.detectClientName("claude-cli/2.0 (linux)", {}), "Claude Code");
  assert.equal(hop.detectClientName("Mozilla/5.0 Chrome/126", {}), "Browser");
  assert.equal(hop.detectClientName("", {}), "");
  assert.equal(hop.parseClientVersion("Cursor/0.42.1"), "0.42.1");
  assert.equal(hop.parseClientVersion("no-version-here"), "");
  assert.equal(hop.findConversationId({ conversation_id: "c1" }), "c1");
  assert.equal(hop.findConversationId({ model: "m" }), "");
  const meta = hop.inboundClientMeta(
    { headers: { "user-agent": "Cursor/0.42.1", "x-request-id": "r1", "x-forwarded-for": "1.2.3.4, 5.6.7.8" } },
    { conversationId: "conv-1" },
  );
  assert.equal(meta.clientName, "Cursor");
  assert.equal(meta.clientVersion, "0.42.1");
  assert.equal(meta.origin, "1.2.3.4");
  assert.equal(meta.requestId, "r1");
  assert.equal(meta.conversationId, "conv-1");
});

test("noteFirstContent ignores role-only frames and fires on content", () => {
  const state = { buf: "" };
  const roleOnly = Buffer.from('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n', "utf8");
  assert.equal(hop.noteFirstContent(state, roleOnly), 0);
  const content = Buffer.from('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "utf8");
  assert.ok(hop.noteFirstContent(state, content) > 0);
});

test("noteFirstContent tolerates chunks split mid-line", () => {
  const state = { buf: "" };
  const full = 'data: {"choices":[{"delta":{"content":"hey"}}]}\n\n';
  const head = Buffer.from(full.slice(0, 20), "utf8");
  const tail = Buffer.from(full.slice(20), "utf8");
  assert.equal(hop.noteFirstContent(state, head), 0);
  assert.ok(hop.noteFirstContent(state, tail) > 0);
});

void readFileSync;
void rmSync;
void writeFileSync;
