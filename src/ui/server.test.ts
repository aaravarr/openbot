import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";

// Force Unix-style box paths so the supervisor's parseAbsPath accepts them on
// every platform (Windows resolves a leading slash against the current drive).
process.env.OPENBOT_REPO = "/tmp/openbot-repo";
process.env.OPENBOT_SAND_DATA = "/tmp/openbot-sand-data";
process.env.OPENBOT_HOST_MAIN = "/tmp/openbot-sand-host/host-main.cjs";
mkdirSync("/tmp/openbot-repo/ui", { recursive: true });
writeFileSync("/tmp/openbot-repo/ui/index.html", "<!doctype html><html><body>test ui</body></html>\n");

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

function requestText(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
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

test("UI root serves index.html and state remains an API route", async () => {
  const { server, port } = await listen();
  try {
    const root = await requestText(port, "/");
    assert.equal(root.status, 200);
    assert.match(root.body, /<!doctype html>/i);

    const state = await request(port, "/api/state", "GET");
    assert.equal(state.status, 200);
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
    utimesSync(agents + "/blank", new Date(1_000), new Date(4_000));
    utimesSync(agents + "/alpha", new Date(1_000), new Date(3_000));
    utimesSync(agents + "/broken", new Date(1_000), new Date(2_000));
    utimesSync(agents + "/missing", new Date(1_000), new Date(1_000));
    writeFileSync("/tmp/openbot-sand-data/openbot-bot-models.json", JSON.stringify({ assignments: { orphan: "provider:model" } }));

    const { server, port } = await listen();
    try {
      const bots = await request(port, "/api/bots", "GET");
      assert.equal(bots.status, 200);
      assert.equal(Array.isArray(bots.json), true);
      const botRows = bots.json as Array<{ botId: string; botName: string; deleted: boolean; updatedAtMs: number | null; createdAtMs: number | null }>;
      assert.deepEqual(botRows.map((bot) => ({ botId: bot.botId, botName: bot.botName, deleted: bot.deleted })), [
        { botId: "blank", botName: "blank", deleted: false },
        { botId: "alpha", botName: "Alpha Bot", deleted: false },
        { botId: "broken", botName: "broken", deleted: true },
        { botId: "missing", botName: "missing", deleted: true },
        { botId: "orphan", botName: "orphan", deleted: true },
      ]);
      assert.deepEqual(botRows.map((bot) => bot.updatedAtMs), [4_000, 3_000, 2_000, 1_000, null]);
      assert.equal(botRows[0]?.createdAtMs, fss.statSync(agents + "/blank/profile.json").birthtimeMs);
      assert.equal(botRows[1]?.createdAtMs, fss.statSync(agents + "/alpha/profile.json").birthtimeMs);
      assert.equal(botRows[2]?.createdAtMs, fss.statSync(agents + "/broken/profile.json").birthtimeMs);
      assert.equal(botRows[3]?.createdAtMs, null);
      assert.equal(botRows[4]?.createdAtMs, null);

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
    rmSync("/tmp/openbot-sand-data/openbot-bot-models.json", { force: true });
    if (previous === undefined) delete process.env.OPENBOT_AGENT_DATA;
    else process.env.OPENBOT_AGENT_DATA = previous;
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

test("/api/state serves an old removed-preset provider as a generic catalog row", async () => {
  const fss = await import("node:fs");
  fss.mkdirSync("/tmp/openbot-sand-data", { recursive: true });
  // DeepSeek was removed from the new-provider presets. A box that saved it
  // before curation must still see the row (with its key state) and keep the
  // wildcard binding, because the Models page and the hop both read this data
  // path unchanged.
  fss.writeFileSync(
    "/tmp/openbot-sand-data/openbot-plan.json",
    JSON.stringify({
      kind: "custom",
      agents: { "*": { modelId: "deepseek-v4-flash", providerId: "deepseek" } },
      catalog: {
        providers: [{ id: "deepseek", name: "DeepSeek", origin: "https://api.deepseek.com", maxTokensDefault: 65536, mapFile: "provider-maps.cjs" }],
        models: [{ id: "deepseek:deepseek-v4-flash", providerId: "deepseek", slug: "deepseek-v4-flash", parameters: [] }],
        bindings: [{ conversation: { kind: "wildcard" }, modelId: "deepseek:deepseek-v4-flash" }],
      },
    }) + "\n",
  );
  fss.writeFileSync("/tmp/openbot-sand-data/secrets.json", JSON.stringify({ providers: { deepseek: "sk-old" } }) + "\n");
  const { server, port } = await listen();
  try {
    const res = await request(port, "/api/state", "GET");
    assert.equal(res.status, 200);
    const body = res.json as {
      providers: { id: string; name: string; origin: string }[];
      models: { id: string; providerId: string; slug: string }[];
      keyedProviders: string[];
      activeModelId: string | null;
    };
    assert.equal(body.providers.length, 1);
    assert.equal(body.providers[0]?.id, "deepseek");
    assert.equal(body.providers[0]?.name, "DeepSeek");
    assert.equal(body.providers[0]?.origin, "https://api.deepseek.com");
    assert.equal(body.models[0]?.slug, "deepseek-v4-flash");
    assert.deepEqual(body.keyedProviders, ["deepseek"]);
    assert.equal(body.activeModelId, "deepseek:deepseek-v4-flash");
  } finally {
    fss.rmSync("/tmp/openbot-sand-data/openbot-plan.json", { force: true });
    fss.rmSync("/tmp/openbot-sand-data/secrets.json", { force: true });
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
