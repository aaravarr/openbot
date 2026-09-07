import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const runtimePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/runtime.cjs");

type HealResult = { ok: boolean; action: string; pid?: number };
type HealOverrides = { host?: string; port?: number; entry?: string; pidFile?: string; logFile?: string };
type RuntimeHeal = {
  HOP_HEAL: Record<string, number>;
  ensureHopUp: (overrides?: HealOverrides, allowSpawn?: boolean) => Promise<HealResult>;
  hopPortOpen: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
  resetHopHealState: () => void;
  hopRequestWithRetry: (body: unknown, healOverrides?: HealOverrides) => Promise<http.IncomingMessage>;
};

function loadRuntime(): RuntimeHeal {
  delete require.cache[runtimePath];
  return require(runtimePath) as RuntimeHeal;
}

const runtime = loadRuntime();

test.beforeEach(() => {
  runtime.resetHopHealState();
});

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "openbot-hop-heal-"));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("no port")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function writeFixture(d: string): string {
  const entry = path.join(d, "fake-hop.cjs");
  writeFileSync(
    entry,
    [
      '"use strict";',
      'var http = require("http");',
      'var fs = require("fs");',
      "var port = Number(process.env.OPENBOT_HOP_PORT);",
      'var marker = process.env.OPENBOT_HEAL_MARKER || "";',
      'if (marker) { try { fs.appendFileSync(marker, "spawned;"); } catch (e) {} }',
      "http.createServer(function (req, res) {",
      '  res.writeHead(200, { "Content-Type": "application/json" });',
      '  res.end(\'{"ok":true}\');',
      '}).listen(port, "127.0.0.1");',
    ].join("\n"),
  );
  return entry;
}

function readPid(pidFile: string): number | undefined {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function killPid(pidFile: string): void {
  const pid = readPid(pidFile);
  if (pid !== undefined) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

test("HOP_HEAL budgets are shaped as documented", () => {
  assert.equal(runtime.HOP_HEAL.probeTimeoutMs, 250);
  assert.equal(runtime.HOP_HEAL.pollMs, 100);
  assert.equal(runtime.HOP_HEAL.startupGraceMs, 3000);
  assert.equal(runtime.HOP_HEAL.spawnWaitMs, 15000);
  assert.equal(runtime.HOP_HEAL.spawnThrottleMs, 10000);
  assert.equal(runtime.HOP_HEAL.shortWaitMs, 2000);
  assert.equal(runtime.HOP_HEAL.retryBudgetMs, 30000);
});

test("ensureHopUp fast-paths when the port is already open", async () => {
  const d = tmpDir();
  const server = http.createServer((_req, res) => {
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  try {
    const result = await runtime.ensureHopUp({
      host: "127.0.0.1",
      port: addr.port,
      entry: path.join(d, "must-not-spawn.cjs"),
      pidFile: path.join(d, "hop.pid"),
      logFile: path.join(d, "hop.log"),
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, "already-up");
    assert.equal(existsSync(path.join(d, "hop.pid")), false);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("ensureHopUp fails fast and never throws when nothing is launchable", async () => {
  const d = tmpDir();
  const port = await freePort();
  const started = Date.now();
  const result = await runtime.ensureHopUp({
    host: "127.0.0.1",
    port,
    entry: path.join(d, "no-such-hop-server.cjs"),
    pidFile: path.join(d, "hop.pid"),
    logFile: path.join(d, "hop.log"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.action, "spawn-failed");
  assert.ok(Date.now() - started < 10000);
});

test("ensureHopUp with allowSpawn=false only confirms", async () => {
  const d = tmpDir();
  const port = await freePort();
  const started = Date.now();
  const result = await runtime.ensureHopUp(
    {
      host: "127.0.0.1",
      port,
      entry: path.join(d, "x.cjs"),
      pidFile: path.join(d, "hop.pid"),
      logFile: path.join(d, "hop.log"),
    },
    false,
  );
  assert.equal(result.ok, false);
  assert.equal(result.action, "still-down");
  assert.ok(Date.now() - started < 10000);
});

test("concurrent healers share one spawn", async () => {
  const d = tmpDir();
  const port = await freePort();
  const marker = path.join(d, "spawns.log");
  const overrides: HealOverrides = {
    host: "127.0.0.1",
    port,
    entry: writeFixture(d),
    pidFile: path.join(d, "hop.pid"),
    logFile: path.join(d, "hop.log"),
  };
  process.env.OPENBOT_HEAL_MARKER = marker;
  try {
    const results = await Promise.all([
      runtime.ensureHopUp(overrides),
      runtime.ensureHopUp(overrides),
      runtime.ensureHopUp(overrides),
      runtime.ensureHopUp(overrides),
      runtime.ensureHopUp(overrides),
    ]);
    for (const result of results) assert.equal(result.ok, true);
    const spawns = readFileSync(marker, "utf8").split("spawned").length - 1;
    assert.equal(spawns, 1);
  } finally {
    delete process.env.OPENBOT_HEAL_MARKER;
    killPid(path.join(d, "hop.pid"));
  }
});

test("hopRequestWithRetry heals a dead hop then replays the request", async () => {
  const d = tmpDir();
  const deadPort = await freePort();
  const marker = path.join(d, "spawns.log");
  const prevHost = process.env.OPENBOT_HOP_HOST;
  const prevPort = process.env.OPENBOT_HOP_PORT;
  const prevMarker = process.env.OPENBOT_HEAL_MARKER;
  process.env.OPENBOT_HOP_HOST = "127.0.0.1";
  process.env.OPENBOT_HOP_PORT = String(deadPort);
  process.env.OPENBOT_HEAL_MARKER = marker;
  delete require.cache[runtimePath];
  const fresh = require(runtimePath) as RuntimeHeal;
  try {
    const res = await fresh.hopRequestWithRetry({ model: "m", messages: [] }, {
      entry: writeFixture(d),
      pidFile: path.join(d, "hop.pid"),
      logFile: path.join(d, "hop.log"),
    });
    assert.equal(res.statusCode, 200);
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    assert.match(text, /"ok":true/);
    const spawns = readFileSync(marker, "utf8").split("spawned").length - 1;
    assert.equal(spawns, 1);
  } finally {
    killPid(path.join(d, "hop.pid"));
    if (prevHost === undefined) delete process.env.OPENBOT_HOP_HOST;
    else process.env.OPENBOT_HOP_HOST = prevHost;
    if (prevPort === undefined) delete process.env.OPENBOT_HOP_PORT;
    else process.env.OPENBOT_HOP_PORT = prevPort;
    if (prevMarker === undefined) delete process.env.OPENBOT_HEAL_MARKER;
    else process.env.OPENBOT_HEAL_MARKER = prevMarker;
  }
});

test("a fresh pidfile waits instead of double-spawning", async () => {
  const d = tmpDir();
  const port = await freePort();
  const marker = path.join(d, "spawns.log");
  const pidFile = path.join(d, "hop.pid");
  writeFileSync(pidFile, "999999998" + "\n");
  const prevWait = runtime.HOP_HEAL.spawnWaitMs;
  assert.ok(typeof prevWait === "number");
  runtime.HOP_HEAL.spawnWaitMs = 1500;
  try {
    const result = await runtime.ensureHopUp({
      host: "127.0.0.1",
      port,
      entry: writeFixture(d),
      pidFile,
      logFile: path.join(d, "hop.log"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.action, "spawn-throttled");
    assert.equal(existsSync(marker), false);
  } finally {
    if (typeof prevWait === "number") runtime.HOP_HEAL.spawnWaitMs = prevWait;
    killPid(pidFile);
  }
});
