import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

type PruneResult = { removedByRetention: number; removedByCap: number; kept: number };
type PruneProgress = { processed: number; kept: number; removedByRetention: number };
type StatsResult = {
  records: number;
  scanned: number;
  approximate: boolean;
  ok: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  bodyBytes: number;
  bodyFiles: number;
  bodyDiskBytes: number;
  bodiesApproximate: boolean;
  diskBytes: number;
};
type FacetValues = { values: Array<{ value: string; count: number }>; approximate: boolean };
type FacetsResult = {
  sampled: number;
  total: number;
  model: FacetValues;
  provider: FacetValues;
  channel: FacetValues;
  status: FacetValues;
};
type EventRow = {
  id: string;
  at: string;
  type: string;
  severity: string;
  message: string;
  requestId?: string;
  metadata?: unknown;
};

// request-log.cjs has no filesystem seam to inject (zero-dep CJS reading
// real fs), so isolation uses its own path override: OPENBOT_SAND_DATA.
// This mirrors the withSand helper in src/logs/request-log.test.ts.
const log = require("../../payload/request-log.cjs") as {
  loadSettings: () => Record<string, unknown>;
  saveSettings: (input: unknown) => Record<string, unknown>;
  recordHop: (input: unknown) => void;
  listRequests: (query?: unknown) => { items: Array<Record<string, unknown>>; total: number };
  pruneNowAsync: (settings: unknown, onBatch?: (progress: PruneProgress) => void) => Promise<PruneResult>;
  cleanupNowAsync: (settings?: unknown) => Promise<PruneResult>;
  statsNow: () => StatsResult;
  facetsNow: () => FacetsResult;
  appendEvent: (input: unknown) => EventRow | null;
  queryEvents: (query?: unknown) => { items: EventRow[]; total: number };
};

const prevEnv = {
  sand: process.env.OPENBOT_SAND_DATA,
  logs: process.env.OPENBOT_LOGS,
  secrets: process.env.OPENBOT_SECRETS,
};

let sandDir = "";

test.beforeEach(() => {
  sandDir = mkdtempSync(path.join(os.tmpdir(), "openbot-logmgmt-"));
  process.env.OPENBOT_SAND_DATA = sandDir;
  delete process.env.OPENBOT_LOGS;
  process.env.OPENBOT_SECRETS = path.join(sandDir, "secrets.json");
  // Aggregate caches are keyed by time, not by directory. Saving settings
  // always invalidates them, so every test starts with a cold cache.
  log.saveSettings(log.loadSettings());
});

test.after(() => {
  if (prevEnv.sand === undefined) delete process.env.OPENBOT_SAND_DATA;
  else process.env.OPENBOT_SAND_DATA = prevEnv.sand;
  if (prevEnv.logs === undefined) delete process.env.OPENBOT_LOGS;
  else process.env.OPENBOT_LOGS = prevEnv.logs;
  if (prevEnv.secrets === undefined) delete process.env.OPENBOT_SECRETS;
  else process.env.OPENBOT_SECRETS = prevEnv.secrets;
});

function reqRow(id: string, startedAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    startedAt,
    completedAt: startedAt,
    ok: true,
    status: 200,
    channel: "hop",
    hasRequest: false,
    hasResponse: false,
    ...extra,
  };
}

function requestLogFile(): string {
  return path.join(sandDir, "openbot-requests.jsonl");
}

function bodiesDir(): string {
  return path.join(sandDir, "openbot-request-bodies");
}

function writeRequestRows(rows: Array<Record<string, unknown>>): void {
  writeFileSync(requestLogFile(), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function readRequestIds(): string[] {
  const text = readFileSync(requestLogFile(), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => (JSON.parse(line) as { id: string }).id);
}

function writeBodyFile(id: string, payload: unknown): void {
  mkdirSync(bodiesDir(), { recursive: true });
  writeFileSync(path.join(bodiesDir(), id + ".json"), JSON.stringify(payload));
}

function bodyFileExists(id: string): boolean {
  return existsSync(path.join(bodiesDir(), id + ".json"));
}

const DAY_MS = 24 * 3600 * 1000;
test("pruneNowAsync removes expired rows and orphan bodies", async () => {
  writeBodyFile("old-1", { request: { a: 1 } });
  writeBodyFile("new-1", { request: { b: 2 } });
  writeRequestRows([
    reqRow("old-1", new Date(Date.now() - 30 * DAY_MS).toISOString()),
    reqRow("old-2", new Date(Date.now() - 10 * DAY_MS).toISOString()),
    reqRow("new-1", new Date(Date.now() - DAY_MS).toISOString()),
    reqRow("new-2", new Date().toISOString()),
    reqRow("new-3", new Date().toISOString()),
  ]);
  const batches: number[] = [];
  const result = await log.pruneNowAsync({ logRetentionDays: 7, maxRecords: 2000 }, (progress) => {
    batches.push(progress.processed);
  });
  assert.equal(result.removedByRetention, 2);
  assert.equal(result.removedByCap, 0);
  assert.equal(result.kept, 3);
  assert.deepEqual(batches, [5]);
  assert.deepEqual(readRequestIds().sort(), ["new-1", "new-2", "new-3"]);
  assert.equal(bodyFileExists("old-1"), false);
  assert.equal(bodyFileExists("new-1"), true);
});

test("pruneNowAsync enforces maxRecords keeping the newest rows", async () => {
  const base = Date.now();
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 10; i++) {
    rows.push(reqRow("cap-" + String(i), new Date(base + i * 1000).toISOString()));
  }
  writeRequestRows(rows);
  const result = await log.pruneNowAsync({ logRetentionDays: 7, maxRecords: 5 });
  assert.equal(result.removedByRetention, 0);
  assert.equal(result.removedByCap, 5);
  assert.equal(result.kept, 5);
  assert.deepEqual(readRequestIds(), ["cap-5", "cap-6", "cap-7", "cap-8", "cap-9"]);
});

test("pruneNowAsync processes 200-row batches and yields to the event loop", async () => {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 450; i++) {
    rows.push(reqRow("batch-" + String(i), new Date().toISOString()));
  }
  writeRequestRows(rows);
  const processed: number[] = [];
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  const result = await log.pruneNowAsync({ logRetentionDays: 7, maxRecords: 2000 }, (progress) => {
    processed.push(progress.processed);
  });
  assert.equal(result.kept, 450);
  assert.equal(result.removedByRetention, 0);
  assert.deepEqual(processed, [200, 400, 450]);
  // The outer setImmediate could only have run if cleanup yielded mid-run:
  // a fully synchronous prune would resolve in microtasks first.
  assert.equal(yielded, true);
});

test("a single small batch resolves without yielding", async () => {
  writeRequestRows([reqRow("tiny-1", new Date().toISOString())]);
  const processed: number[] = [];
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  const result = await log.pruneNowAsync({ logRetentionDays: 7, maxRecords: 2000 }, (progress) => {
    processed.push(progress.processed);
  });
  assert.equal(result.kept, 1);
  assert.deepEqual(processed, [1]);
  assert.equal(yielded, false);
});

test("statsNow sums metadata and caches until a write invalidates it", () => {
  writeRequestRows([
    reqRow("s-1", new Date().toISOString(), {
      ok: true,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      bodyBytes: 100,
    }),
    reqRow("s-2", new Date().toISOString(), { ok: false, status: 500, error: "boom" }),
    reqRow("s-3", new Date().toISOString(), { ok: true, model: "m-x" }),
  ]);
  const first = log.statsNow();
  assert.equal(first.records, 3);
  assert.equal(first.scanned, 3);
  assert.equal(first.approximate, false);
  assert.equal(first.ok, 2);
  assert.equal(first.errors, 1);
  assert.equal(first.promptTokens, 10);
  assert.equal(first.completionTokens, 5);
  assert.equal(first.totalTokens, 15);
  assert.equal(first.bodyBytes, 100);
  assert.ok(first.diskBytes > 0);
  // Cache hit: same object reference within the 60s TTL.
  assert.ok(log.statsNow() === first);

  // A recorded hop precomputes bodyBytes and invalidates the cache.
  log.saveSettings({ loggingEnabled: true, logBodies: true });
  log.recordHop({
    id: "s-4-probe-01",
    status: 200,
    model: "m-x",
    requestBody: { ping: 1 },
    responseBody: { pong: 1 },
  });
  const row = log.listRequests({}).items.find((item) => item.id === "s-4-probe-01");
  assert.ok(row);
  assert.ok(typeof row.bodyBytes === "number" && (row.bodyBytes as number) > 0);
  const after = log.statsNow();
  assert.ok(after !== first);
  assert.equal(after.records, 4);
  assert.ok(after.bodyBytes > first.bodyBytes);
  assert.equal(after.bodyFiles, 1);
});

test("statsNow caps the scan and marks large logs approximate", () => {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 1050; i++) {
    rows.push(reqRow("big-" + String(i), new Date().toISOString()));
  }
  writeRequestRows(rows);
  const stats = log.statsNow();
  assert.equal(stats.records, 1050);
  assert.equal(stats.scanned, 1000);
  assert.equal(stats.approximate, true);
  assert.equal(stats.ok + stats.errors, stats.scanned);
});

test("facetsNow counts and orders options", () => {
  writeRequestRows([
    reqRow("f-1", new Date().toISOString(), { model: "m-a", providerId: "p1", channel: "hop", status: 200 }),
    reqRow("f-2", new Date().toISOString(), { model: "m-a", providerId: "p1", channel: "hop", status: 200 }),
    reqRow("f-3", new Date().toISOString(), { model: "m-a", providerId: "p2", channel: "custom-host", status: 500 }),
    reqRow("f-4", new Date().toISOString(), { model: "m-b", providerId: "p2", channel: "hop", status: 200 }),
  ]);
  const facets = log.facetsNow();
  assert.equal(facets.sampled, 4);
  assert.equal(facets.total, 4);
  assert.deepEqual(facets.model.values[0], { value: "m-a", count: 3 });
  assert.deepEqual(facets.channel.values[0], { value: "hop", count: 3 });
  assert.deepEqual(
    facets.status.values.find((option) => option.value === "200"),
    { value: "200", count: 3 },
  );
  assert.equal(facets.model.approximate, false);
});

test("facetsNow caps each facet at 200 options", () => {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 210; i++) {
    rows.push(reqRow("cap-m-" + String(i), new Date().toISOString(), { model: "model-" + String(i) }));
  }
  writeRequestRows(rows);
  const facets = log.facetsNow();
  assert.equal(facets.sampled, 210);
  assert.equal(facets.total, 210);
  assert.equal(facets.model.values.length, 200);
  assert.equal(facets.model.approximate, true);
});

test("facetsNow samples only the newest 5000 rows", () => {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 5001; i++) {
    rows.push(reqRow("sample-" + String(i), new Date().toISOString(), { model: "m" }));
  }
  writeRequestRows(rows);
  const facets = log.facetsNow();
  assert.equal(facets.total, 5001);
  assert.equal(facets.sampled, 5000);
  assert.deepEqual(facets.model.values, [{ value: "m", count: 5000 }]);
  assert.equal(facets.model.approximate, true);
});

test("appendEvent and queryEvents filter by severity, type and requestId", () => {
  const first = log.appendEvent({
    at: "2026-01-01T00:00:00.000Z",
    type: "test.deploy",
    severity: "warn",
    message: "hello",
    requestId: "req-1",
    metadata: { attempt: 1 },
  });
  assert.ok(first);
  assert.equal(first.severity, "WARN");
  assert.equal(first.requestId, "req-1");
  assert.deepEqual(first.metadata, { attempt: 1 });
  const second = log.appendEvent({
    at: "2026-01-01T00:00:01.000Z",
    type: "test.deploy",
    severity: "error",
    message: "boom",
  });
  assert.ok(second);
  assert.equal(second.severity, "ERROR");

  const byType = log.queryEvents({ type: "test.deploy" });
  assert.equal(byType.total, 2);
  assert.equal(byType.items[0]?.id, second.id);
  assert.equal(byType.items[1]?.id, first.id);

  assert.equal(log.queryEvents({ severity: "warn" }).total, 1);
  assert.equal(log.queryEvents({ severity: "ERROR" }).total, 1);
  assert.equal(log.queryEvents({ severity: "INFO" }).total, 0);
  assert.equal(log.queryEvents({ requestId: "req-1" }).total, 1);

  const limited = log.queryEvents({ type: "test.deploy", limit: 1 });
  assert.equal(limited.items.length, 1);
  assert.equal(limited.total, 2);

  const normalized = log.appendEvent({ type: "t", severity: "bogus", message: "x" });
  assert.ok(normalized);
  assert.equal(normalized.severity, "INFO");
  const fallback = log.appendEvent({});
  assert.ok(fallback);
  assert.equal(fallback.type, "note");
});

test("cleanupNowAsync prunes expired rows and appends a logs.cleanup event", async () => {
  writeRequestRows([
    reqRow("c-old", new Date(Date.now() - 30 * DAY_MS).toISOString()),
    reqRow("c-new", new Date().toISOString()),
  ]);
  const result = await log.cleanupNowAsync({ logRetentionDays: 7, maxRecords: 2000 });
  assert.equal(result.removedByRetention, 1);
  assert.equal(result.removedByCap, 0);
  assert.equal(result.kept, 1);
  assert.deepEqual(readRequestIds(), ["c-new"]);
  const events = log.queryEvents({ type: "logs.cleanup" });
  assert.equal(events.total, 1);
  const item = events.items[0];
  assert.ok(item);
  assert.equal(item.severity, "INFO");
  const metadata = item.metadata as { removedByRetention?: number; kept?: number };
  assert.equal(metadata.removedByRetention, 1);
  assert.equal(metadata.kept, 1);
});
