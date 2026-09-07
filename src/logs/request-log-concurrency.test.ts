import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type RequestLog = {
  saveSettings: (input: unknown) => unknown;
  recordHop: (input: unknown) => void;
  pruneNow: (settings: unknown) => void;
  pruneNowAsync: (settings?: unknown) => Promise<{
    skipped?: boolean;
    removedByRetention: number;
    removedByCap: number;
    kept: number;
  }>;
  getRequest: (id: string) => { bodyMissing?: boolean } | null;
};

const require = createRequire(import.meta.url);
const log = require("../../payload/request-log.cjs") as RequestLog;
const REQLOG = fileURLToPath(new URL("../../payload/request-log.cjs", import.meta.url));

const KIDS = 4;
const PER_KID = 30;

function childDriver(): string {
  return [
    `"use strict";`,
    `const log = require(${JSON.stringify(REQLOG)});`,
    `const kid = Number(process.argv[2]);`,
    `const count = Number(process.argv[3]);`,
    `for (let i = 0; i < count; i++) {`,
    `  log.recordHop({`,
    `    id: "conc-" + kid + "-" + i,`,
    `    startedAt: new Date().toISOString(),`,
    `    status: 200,`,
    `    channel: kid % 2 === 0 ? "hop" : "custom-host",`,
    `    model: "test-model",`,
    `    requestBody: { kid, i, prompt: "hello" },`,
    `    responseBody: { kid, i, reply: "world" },`,
    `  });`,
    `  if (i % 5 === 4) log.pruneNow({ logRetentionDays: 7 });`,
    `}`,
  ].join("\n") + "\n";
}

function runKid(driver: string, env: NodeJS.ProcessEnv, kid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [driver, String(kid), String(PER_KID)], { env });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`kid ${kid} exited with ${code}: ${stderr}`));
    });
  });
}

function readRows(dir: string): Array<{ id: string; hasRequest?: boolean; hasResponse?: boolean }> {
  const text = readFileSync(path.join(dir, "openbot-requests.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { id: string; hasRequest?: boolean; hasResponse?: boolean });
}

test("concurrent record + prune across processes loses no rows or bodies", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-lograce-"));
  const driverDir = mkdtempSync(path.join(os.tmpdir(), "openbot-lograce-bin-"));
  const driver = path.join(driverDir, "kid.cjs");
  writeFileSync(driver, childDriver());
  const prevSand = process.env.OPENBOT_SAND_DATA;
  const prevLogs = process.env.OPENBOT_LOGS;
  const prevSecrets = process.env.OPENBOT_SECRETS;
  process.env.OPENBOT_SAND_DATA = dir;
  delete process.env.OPENBOT_LOGS;
  process.env.OPENBOT_SECRETS = path.join(dir, "secrets.json");
  try {
    log.saveSettings({ loggingEnabled: true, logBodies: true, logBodiesOnError: true, logRetentionDays: 7 });
    const bodiesDir = path.join(dir, "openbot-request-bodies");
    // A fresh orphan (mid-write from another process) must survive pruning;
    // a stale orphan (older than the grace window) is reaped.
    mkdirSync(bodiesDir, { recursive: true });
    writeFileSync(path.join(bodiesDir, "conc-fresh-orphan.json"), JSON.stringify({ request: { a: 1 } }));
    writeFileSync(path.join(bodiesDir, "conc-old-orphan.json"), JSON.stringify({ request: { a: 2 } }));
    const old = Date.now() - 2 * 3600 * 1000;
    utimesSync(path.join(bodiesDir, "conc-old-orphan.json"), new Date(old), new Date(old));
    const env = { ...process.env };
    await Promise.all(Array.from({ length: KIDS }, (_, kid) => runKid(driver, env, kid)));
    await log.pruneNowAsync({ logRetentionDays: 7 });
    const rows = readRows(dir);
    assert.equal(rows.length, KIDS * PER_KID);
    assert.equal(new Set(rows.map((row) => row.id)).size, KIDS * PER_KID);
    for (const row of rows) {
      assert.equal(row.hasRequest, true, `row ${row.id} should claim a request body`);
      assert.equal(row.hasResponse, true, `row ${row.id} should claim a response body`);
      assert.equal(
        existsSync(path.join(bodiesDir, row.id + ".json")),
        true,
        `row ${row.id} is present but its body file is gone`,
      );
    }
    assert.equal(existsSync(path.join(bodiesDir, "conc-fresh-orphan.json")), true);
    assert.equal(existsSync(path.join(bodiesDir, "conc-old-orphan.json")), false);
    assert.equal(existsSync(path.join(dir, "openbot-requests.lock")), false);
    const detail = log.getRequest("conc-0-0");
    assert.equal(detail?.bodyMissing, undefined);
  } finally {
    if (prevSand === undefined) delete process.env.OPENBOT_SAND_DATA;
    else process.env.OPENBOT_SAND_DATA = prevSand;
    if (prevLogs === undefined) delete process.env.OPENBOT_LOGS;
    else process.env.OPENBOT_LOGS = prevLogs;
    if (prevSecrets === undefined) delete process.env.OPENBOT_SECRETS;
    else process.env.OPENBOT_SECRETS = prevSecrets;
  }
});

test("a stale prune lock does not wedge pruning", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-loglock-"));
  const prevSand = process.env.OPENBOT_SAND_DATA;
  const prevLogs = process.env.OPENBOT_LOGS;
  const prevSecrets = process.env.OPENBOT_SECRETS;
  process.env.OPENBOT_SAND_DATA = dir;
  delete process.env.OPENBOT_LOGS;
  process.env.OPENBOT_SECRETS = path.join(dir, "secrets.json");
  try {
    log.saveSettings({ loggingEnabled: true, logRetentionDays: 7 });
    const lock = path.join(dir, "openbot-requests.lock");
    writeFileSync(lock, "999999\n");
    const old = Date.now() - 10 * 60 * 1000;
    utimesSync(lock, new Date(old), new Date(old));
    const result = await log.pruneNowAsync({ logRetentionDays: 7 });
    assert.notEqual(result.skipped, true);
    assert.equal(existsSync(lock), false);
  } finally {
    if (prevSand === undefined) delete process.env.OPENBOT_SAND_DATA;
    else process.env.OPENBOT_SAND_DATA = prevSand;
    if (prevLogs === undefined) delete process.env.OPENBOT_LOGS;
    else process.env.OPENBOT_LOGS = prevLogs;
    if (prevSecrets === undefined) delete process.env.OPENBOT_SECRETS;
    else process.env.OPENBOT_SECRETS = prevSecrets;
  }
});

test("overlapping prunes serialize without corrupting the log", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-logoverlap-"));
  const prevSand = process.env.OPENBOT_SAND_DATA;
  const prevLogs = process.env.OPENBOT_LOGS;
  const prevSecrets = process.env.OPENBOT_SECRETS;
  process.env.OPENBOT_SAND_DATA = dir;
  delete process.env.OPENBOT_LOGS;
  process.env.OPENBOT_SECRETS = path.join(dir, "secrets.json");
  try {
    log.saveSettings({ loggingEnabled: true, logBodies: true, logRetentionDays: 7 });
    for (let i = 0; i < 10; i++) {
      log.recordHop({
        id: `overlap-${i}`,
        startedAt: new Date().toISOString(),
        status: 200,
        requestBody: { i },
        responseBody: { i },
      });
    }
    const settings = { logRetentionDays: 7 };
    const [a, b] = await Promise.all([log.pruneNowAsync(settings), log.pruneNowAsync(settings)]);
    // Both passes resolve (at most one may report skipping on the lock) and
    // the log keeps every row either way.
    assert.equal(typeof a.kept === "number" || a.skipped === true, true);
    assert.equal(typeof b.kept === "number" || b.skipped === true, true);
    const rows = readRows(dir);
    assert.equal(rows.length, 10);
    assert.equal(new Set(rows.map((row) => row.id)).size, 10);
  } finally {
    if (prevSand === undefined) delete process.env.OPENBOT_SAND_DATA;
    else process.env.OPENBOT_SAND_DATA = prevSand;
    if (prevLogs === undefined) delete process.env.OPENBOT_LOGS;
    else process.env.OPENBOT_LOGS = prevLogs;
    if (prevSecrets === undefined) delete process.env.OPENBOT_SECRETS;
    else process.env.OPENBOT_SECRETS = prevSecrets;
  }
});
