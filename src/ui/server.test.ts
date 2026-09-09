import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";

// Force Unix-style box paths so the supervisor's parseAbsPath accepts them on
// every platform (Windows resolves a leading slash against the current drive).
process.env.OPENBOT_REPO = "/tmp/openbot-repo";
process.env.OPENBOT_SAND_DATA = "/tmp/openbot-sand-data";
process.env.OPENBOT_HOST_MAIN = "/tmp/openbot-sand-host/host-main.cjs";

const { handleRequest, wrapMode } = await import("./server.ts");

function listen(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      void handleRequest(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("no port");
      }
      resolve({ server, port: addr.port });
    });
  });
}

function request(
  port: number,
  pathname: string,
  method: string,
  body?: Buffer,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
    };
    if (body) {
      options.headers = { "Content-Type": "application/json", "Content-Length": String(body.length) };
    }
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) as unknown });
      });
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

test("wrapMode is strict: only an exact official mode file means official", () => {
  assert.equal(wrapMode("official\n"), "official");
  assert.equal(wrapMode(" official \n"), "official");
  // User-owned state must not silently fall back to official.
  assert.equal(wrapMode("custom\n"), "custom");
  assert.equal(wrapMode(undefined), "custom");
  assert.equal(wrapMode(""), "custom");
  assert.equal(wrapMode("   \n"), "custom");
  assert.equal(wrapMode("garbage"), "custom");
  assert.equal(wrapMode("OFFICIAL"), "custom");
  assert.equal(wrapMode("official-mode"), "custom");
});

test("GET /api/pause defaults to unpaused when no state file exists", async () => {
  const { server, port } = await listen();
  try {
    const fss = await import("node:fs");
    fss.rmSync("/tmp/openbot-sand-data/openbot-pause.json", { force: true });
    const res = await request(port, "/api/pause", "GET");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { paused: false, at: null, note: null });
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("PUT /api/pause flips the flag, persists atomically, and logs an event", async () => {
  const { server, port } = await listen();
  try {
    const fss = await import("node:fs");
    fss.rmSync("/tmp/openbot-sand-data/openbot-pause.json", { force: true });
    const put = await request(port, "/api/pause", "PUT", Buffer.from(JSON.stringify({ paused: true, note: "deploy freeze" })));
    assert.equal(put.status, 200);
    const state = put.json as { paused: boolean; at: string; note: string };
    assert.equal(state.paused, true);
    assert.equal(state.note, "deploy freeze");
    assert.equal(typeof state.at, "string");
    assert.equal(fss.existsSync("/tmp/openbot-sand-data/openbot-pause.json.tmp"), false);
    const onDisk = JSON.parse(fss.readFileSync("/tmp/openbot-sand-data/openbot-pause.json", "utf8")) as typeof state;
    assert.deepEqual(onDisk, state);
    const got = await request(port, "/api/pause", "GET");
    assert.equal(got.status, 200);
    assert.deepEqual(got.json, state);
    const events = await request(port, "/api/logs/events", "GET");
    assert.equal(events.status, 200);
    const items = (events.json as { items: { type: string; severity: string }[] }).items;
    const pauseEvents = items.filter((row) => row.type === "gateway.pause");
    assert.ok(pauseEvents.length >= 1);
    assert.equal(pauseEvents[0]?.severity, "WARN");
    const resume = await request(port, "/api/pause", "PUT", Buffer.from(JSON.stringify({ paused: false })));
    assert.equal(resume.status, 200);
    assert.equal((resume.json as { paused: boolean }).paused, false);
    assert.equal((resume.json as { note: string | null }).note, null);
    const after = await request(port, "/api/logs/events", "GET");
    const latest = ((after.json as { items: { type: string; severity: string }[] }).items).filter((row) => row.type === "gateway.pause")[0];
    assert.equal(latest?.severity, "INFO");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("PUT /api/pause rejects malformed payloads", async () => {
  const { server, port } = await listen();
  try {
    const badJson = await request(port, "/api/pause", "PUT", Buffer.from("{nope"));
    assert.equal(badJson.status, 400);
    const badType = await request(port, "/api/pause", "PUT", Buffer.from(JSON.stringify({ paused: "yes" })));
    assert.equal(badType.status, 400);
    const badNote = await request(port, "/api/pause", "PUT", Buffer.from(JSON.stringify({ paused: true, note: 42 })));
    assert.equal(badNote.status, 400);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("bot endpoints discover profiles and persist validated pause state", async () => {
  const agentData = mkdtempSync("/tmp/openbot-agent-data-");
  const agents = agentData + "/agents";
  const previous = process.env.OPENBOT_AGENT_DATA;
  process.env.OPENBOT_AGENT_DATA = agentData;
  try {
    rmSync("/tmp/openbot-sand-data/openbot-pause-bots.json", { force: true });
    const fss = await import("node:fs");
    fss.mkdirSync(agents + "/alpha", { recursive: true });
    writeFileSync(agents + "/alpha/profile.json", JSON.stringify({ name: "Alpha Bot" }));
    fss.mkdirSync(agents + "/missing", { recursive: true });
    fss.mkdirSync(agents + "/blank", { recursive: true });
    writeFileSync(agents + "/blank/profile.json", JSON.stringify({ title: "No name" }));
    fss.mkdirSync(agents + "/broken", { recursive: true });
    writeFileSync(agents + "/broken/profile.json", "{broken");

    const { server, port } = await listen();
    try {
      const bots = await request(port, "/api/bots", "GET");
      assert.equal(bots.status, 200);
      assert.deepEqual(bots.json, [
        { botId: "alpha", botName: "Alpha Bot" },
        { botId: "blank", botName: "blank" },
        { botId: "broken", botName: "broken" },
        { botId: "missing", botName: "missing" },
      ]);

      const missing = await request(port, "/api/pause-bots", "GET");
      assert.deepEqual(missing.json, { pausedBotIds: [] });
      const badJson = await request(port, "/api/pause-bots", "PUT", Buffer.from("{bad"));
      assert.equal(badJson.status, 400);
      const badShape = await request(port, "/api/pause-bots", "PUT", Buffer.from(JSON.stringify({ pausedBotIds: ["ok", 1] })));
      assert.equal(badShape.status, 400);
      const badToggle = await request(port, "/api/pause-bots", "PUT", Buffer.from(JSON.stringify({ botId: "alpha" })));
      assert.equal(badToggle.status, 400);

      const paused = await request(port, "/api/pause-bots", "PUT", Buffer.from(JSON.stringify({ botId: "alpha", paused: true })));
      assert.deepEqual(paused.json, { pausedBotIds: ["alpha"] });
      const onDisk = readFileSync("/tmp/openbot-sand-data/openbot-pause-bots.json", "utf8");
      assert.equal(onDisk.endsWith("\n"), true);
      assert.equal(onDisk.includes("\\n"), false);
      const replaced = await request(port, "/api/pause-bots", "PUT", Buffer.from(JSON.stringify({ pausedBotIds: ["missing", "alpha", "alpha"] })));
      assert.deepEqual(replaced.json, { pausedBotIds: ["alpha", "missing"] });
      const resumed = await request(port, "/api/pause-bots", "PUT", Buffer.from(JSON.stringify({ botId: "alpha", paused: false })));
      assert.deepEqual(resumed.json, { pausedBotIds: ["missing"] });
    } finally {
      server.close();
      server.closeAllConnections();
    }
  } finally {
    rmSync(agentData, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENBOT_AGENT_DATA;
    else process.env.OPENBOT_AGENT_DATA = previous;
  }
});

test("concurrent pause-bots toggles merge instead of clobbering each other", async () => {
  rmSync("/tmp/openbot-sand-data/openbot-pause-bots.json", { force: true });
  const { server, port } = await listen();
  try {
    const [a, b] = await Promise.all([
      request(port, "/api/pause-bots", "PUT", Buffer.from(JSON.stringify({ botId: "bot-a", paused: true }))),
      request(port, "/api/pause-bots", "PUT", Buffer.from(JSON.stringify({ botId: "bot-b", paused: true }))),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const got = await request(port, "/api/pause-bots", "GET");
    assert.deepEqual(got.json, { pausedBotIds: ["bot-a", "bot-b"] });
    const onDisk = JSON.parse(readFileSync("/tmp/openbot-sand-data/openbot-pause-bots.json", "utf8")) as { pausedBotIds: string[] };
    assert.deepEqual(onDisk.pausedBotIds, ["bot-a", "bot-b"]);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("PUT /api/pause-bots trims batch ids before dedupe and sort", async () => {
  rmSync("/tmp/openbot-sand-data/openbot-pause-bots.json", { force: true });
  const { server, port } = await listen();
  try {
    const res = await request(port, "/api/pause-bots", "PUT", Buffer.from(JSON.stringify({ pausedBotIds: [" beta ", "alpha", " alpha "] })));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { pausedBotIds: ["alpha", "beta"] });
    const onDisk = readFileSync("/tmp/openbot-sand-data/openbot-pause-bots.json", "utf8");
    assert.equal(onDisk.includes(" beta "), false);
    assert.equal(onDisk.includes(" alpha "), false);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("GET /api/logs/usage returns grouped usage with an approximate flag", async () => {
  const { server, port } = await listen();
  try {
    const res = await request(port, "/api/logs/usage?model=m-x", "GET");
    assert.equal(res.status, 200);
    const body = res.json as {
      approximate: boolean;
      scanned: number;
      total: number;
      byDay: unknown[];
      byModel: unknown[];
      byProvider: unknown[];
    };
    assert.equal(typeof body.approximate, "boolean");
    assert.equal(typeof body.scanned, "number");
    assert.ok(Array.isArray(body.byDay));
    assert.ok(Array.isArray(body.byModel));
    assert.ok(Array.isArray(body.byProvider));
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("a throwing handler returns a structured 500 and the server keeps serving", async () => {
  const { server, port } = await listen();
  try {
    // "bogus" is not a valid UI command, so parseUiCommand throws inside the
    // /api/save handler and must surface as a structured 500, not a crash.
    const bad = await request(port, "/api/save", "POST", Buffer.from(JSON.stringify({ kind: "bogus" })));
    assert.equal(bad.status, 500);
    const body = bad.json as { error: { kind: string; message: string } };
    assert.equal(body.error.kind, "internal");
    assert.match(body.error.message, /unknown UI command/);

    // The process survives the handler throw and keeps answering requests.
    const alive = await request(port, "/api/state", "GET");
    assert.equal(alive.status, 200);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("process guards keep the process alive on an unhandled rejection", () => {
  // Run in a child process: in the test runner's own process an unhandled
  // rejection is reported as a test failure, so proving "not fatal" needs the
  // real exit semantics of a standalone node process.
  const serverUrl = new URL("./server.ts", import.meta.url).href;
  const script = [
    `import(${JSON.stringify(serverUrl)}).then(({ registerProcessFallbacks }) => {`,
    `  let logged = false;`,
    `  registerProcessFallbacks((line) => {`,
    `    if (line.includes("unhandled rejection") && line.includes("openbot-child-boom")) logged = true;`,
    `  });`,
    `  void Promise.reject(new Error("openbot-child-boom"));`,
    `  setTimeout(() => {`,
    `    if (logged) { process.stdout.write("survived\\n"); process.exit(0); }`,
    `    process.exit(2);`,
    `  }, 150);`,
    `}).catch((err) => { process.stderr.write(String(err && err.stack ? err.stack : err)); process.exit(3); });`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--eval", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENBOT_REPO: "/tmp/openbot-repo",
      OPENBOT_SAND_DATA: "/tmp/openbot-sand-data",
      OPENBOT_HOST_MAIN: "/tmp/openbot-sand-host/host-main.cjs",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /survived/);
});
