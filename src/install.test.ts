import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OPENBOT_MARKER } from "./domain/types.ts";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const installSh = path.join(repoRoot, "install.sh");
const UI = "http://127.0.0.1:9280";

const STOCK = `function createProtoSessionProvider(client) {
  return { getSession: function () { return 1; } };
}
`;

function killPidFile(file: string): void {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
  });
}

test("install.sh refuses a machine without the Computer host file", () => {
  const result = spawnSync("bash", [installSh], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENBOT_HOST_MAIN: "/tmp/openbot-missing-host-main.cjs",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Grok Bot Computer/);
  assert.match(result.stderr, /Missing \/tmp\/openbot-missing-host-main\.cjs/);
});

test("install.sh fetches Node 22 when the box node is too old", () => {
  const body = readFileSync(installSh, "utf8");
  assert.match(body, /ensure_node/);
  assert.match(body, /node22/);
  assert.match(body, /node-\$\{NODE_VERSION\}-\$\{file\}/);
  assert.match(body, /linux-x64/);
});

test("install.sh copies the tree, leaves the host stock, and starts the UI", async () => {
  const box = mkdtempSync(path.join(os.tmpdir(), "openbot-install-box-"));
  const src = mkdtempSync(path.join(os.tmpdir(), "openbot-install-src-"));
  const hostMain = path.join(box, "sand-host", "host-main.cjs");
  const sandData = path.join(box, "sand-data");
  mkdirSync(path.join(box, "sand-host"));
  mkdirSync(sandData);
  writeFileSync(hostMain, STOCK);
  for (const name of ["src", "ui", "payload", "package.json"]) {
    cpSync(path.join(repoRoot, name), path.join(src, name), { recursive: true });
  }

  const result = spawnSync("bash", [installSh], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      OPENBOT_HOST_MAIN: hostMain,
      OPENBOT_SAND_DATA: sandData,
      OPENBOT_SRC: src,
      OPENBOT_DEST: path.join(sandData, "openbot"),
      OPENBOT_TUNNEL: "off",
    },
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OpenBot is ready/);
    assert.match(result.stdout, /This Computer/);
    assert.match(result.stdout, /http:\/\/127\.0\.0\.1:9280/);
    assert.equal(result.stdout.includes("wrapBytesChanged"), false);
    assert.equal(readFileSync(hostMain, "utf8").includes(OPENBOT_MARKER), false);
    assert.equal(readFileSync(hostMain, "utf8").includes("function createProtoSessionProvider(client)"), true);
    const html = await get(`${UI}/`);
    assert.equal(html.status, 200);
    assert.match(html.body, /OpenBot/);
    assert.match(html.body, /id="root"/);
    assert.match(html.body, /app\.js/);
    assert.match(html.body, /styles\.css/);
    assert.match(html.body, /favicon\.svg/);
    assert.equal(html.body.includes("Catalog"), false);
    assert.equal(html.body.includes("Origin"), false);
    assert.equal(html.body.includes("Model slug"), false);
    assert.equal(html.body.includes("Your models. Stock Grok"), false);
    assert.equal(html.body.includes(">Now<"), false);
    const app = await get(`${UI}/app.js`);
    assert.equal(app.status, 200);
    assert.match(app.body, /Start chatting/);
    assert.match(app.body, /Use any model in Grok Bot/);
    assert.match(app.body, /Choose a provider to continue/);
    assert.match(app.body, /Your endpoint/);
    assert.match(app.body, /Base URL/);
    assert.match(app.body, /Model ID/);
    assert.match(app.body, /API Key/);
    assert.match(app.body, /Add provider/);
    assert.match(app.body, /Official Grok/);
    assert.match(app.body, /Grok Bot uses one model at a time/);
    assert.match(app.body, /Add model/);
    assert.match(app.body, /New model/);
    assert.match(app.body, /Save model/);
    assert.match(app.body, /Save API Key/);
    assert.match(app.body, /Save endpoint/);
    assert.match(app.body, /Edit endpoint/);
    assert.match(app.body, /Configure/);
    assert.match(app.body, /Max output/);
    assert.match(app.body, /Reasoning levels/);
    assert.match(app.body, /Input types/);
    assert.match(app.body, /Default omits thinking fields/);
    assert.match(app.body, /These chips choose what Chat can pick/);
    assert.match(app.body, /Thinking for /);
    assert.match(app.body, /Open from phone with Cloudflare Tunnel/);
    assert.match(app.body, /Skip to content/);
    assert.match(app.body, /\bOff\b/);
    assert.equal(app.body.includes("On Chat now"), false);
    assert.equal(app.body.includes("thinking-now-label"), false);
    assert.equal(app.body.includes("Save provider"), false);
    assert.equal(app.body.includes("Leave blank to keep the saved key"), false);
    assert.equal(app.body.includes("<select"), false);
    assert.equal(app.body.includes("Catalog"), false);
    assert.equal(app.body.includes("Model slug"), false);
    assert.equal(app.body.includes("This chat"), false);
    assert.equal(app.body.includes("Use official Grok"), false);
    assert.equal(app.body.includes("Keys and model limits live here"), false);
    assert.equal(app.body.includes("Pick a model and a reasoning level"), false);
    const css = await get(`${UI}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.body, /#f7f7f4/);
    assert.match(css.body, /#f54e00/);
    assert.equal(css.body.includes("box-shadow"), false);
    assert.match(css.body, /menu-panel/);
    assert.match(css.body, /menu-trigger/);
    const favicon = await get(`${UI}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.body, /svg/i);
    const missing = await get(`${UI}/favicon.ico`);
    assert.equal(missing.status, 404);
    const health = await get(`${UI}/healthz`);
    assert.equal(health.status, 200);
    assert.match(health.body, /openbot/);
    const state = await get(`${UI}/api/state`);
    assert.equal(state.status, 200);
    const parsed = JSON.parse(state.body) as {
      snapshot: {
        wrap: { kind: string };
        uiListen: { kind: string; port?: number };
        hopListen: { kind: string; port?: number };
      };
      catalog?: unknown;
    };
    assert.equal(parsed.snapshot.wrap.kind, "stock-unmarked");
    assert.equal(parsed.snapshot.uiListen.kind, "ours");
    assert.equal(parsed.snapshot.hopListen.kind, "ours");
    assert.equal(parsed.snapshot.uiListen.port, 9280);
    assert.equal(parsed.snapshot.hopListen.port, 9280);
    assert.equal("catalog" in parsed, false);
  } finally {
    killPidFile(path.join(sandData, "openbot-ui.pid"));
    killPidFile(path.join(sandData, "openbot-hop.pid"));
  }
});
