import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OPENBOT_MARKER } from "./domain/types.ts";
import { skipOnWindows } from "./test-platform.ts";

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
  assert.match(body, /stamp_payload_version/);
  assert.match(body, /payload\/version\.json/);
  assert.match(body, /OPENBOT_COMMIT/);
});

test("install.sh vendors compression deps, retries npmmirror, and warns loudly when npm fails", () => {
  const body = readFileSync(installSh, "utf8");
  // Vendored copies are the offline path and skip the npm step entirely.
  assert.match(body, /payload_vendor_compression_present/);
  assert.match(body, /payload\/vendor\/pngjs\/package\.json/);
  assert.match(body, /payload\/vendor\/jpeg-js\/package\.json/);
  // npmjs failure falls back to the npmmirror registry.
  assert.match(body, /--registry=https:\/\/registry\.npmmirror\.com/);
  // A double failure is a prominent WARN with a remediation hint, never silent.
  assert.match(body, /WARN: OpenBot could not npm-install/);
  assert.match(body, /Remediation/);
  assert.match(body, /OPENBOT_SKIP_NPM_INSTALL/);
});

test("bot-mode falls back from a 403 codeload source to the GitHub archive", async (t) => {
  if (skipOnWindows(t)) return;
  const data = mkdtempSync(path.join(os.tmpdir(), "openbot-download-fallback-"));
  const release = mkdtempSync(path.join(os.tmpdir(), "openbot-download-release-"));
  const releaseRoot = path.join(release, "openbot-main");
  const host = path.join(data, "host-main.cjs");
  const archive = path.join(data, "release.tar.gz");
  const result = path.join(data, "result.json");
  writeFileSync(host, STOCK);
  mkdirSync(releaseRoot);
  writeFileSync(path.join(releaseRoot, "package.json"), "{}\n");
  execFileSync("tar", ["-czf", archive, "-C", release, "openbot-main"]);
  const server = http.createServer((req, res) => {
    if (req.url === "/codeload") {
      res.writeHead(403);
      res.end("blocked");
      return;
    }
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(readFileSync(archive));
  });
  t.after(() => {
    server.close();
    rmSync(data, { recursive: true, force: true });
    rmSync(release, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const run = spawnSync("bash", [installSh, "--bot-mode-worker"], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      OPENBOT_HOST_MAIN: host,
      OPENBOT_SAND_DATA: data,
      OPENBOT_BOT_RESULT: result,
      OPENBOT_BOT_LOG: path.join(data, "install.log"),
      OPENBOT_BOT_PID: path.join(data, "install.pid"),
      OPENBOT_TARBALL: `http://127.0.0.1:${port}/codeload`,
      OPENBOT_ARCHIVE_TARBALL: `http://127.0.0.1:${port}/archive`,
      OPENBOT_COMMIT: "cafed00d",
      OPENBOT_SKIP_NPM_INSTALL: "1",
      OPENBOT_TEST_DOWNLOAD_ONLY: "1",
    },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const state = JSON.parse(readFileSync(result, "utf8")) as { downloadSource: string };
  assert.equal(state.downloadSource, "github-archive");
  assert.match(run.stderr, /source=codeload attempt=1 failed \(HTTP 403/);
});

test("bot-mode reports every failed source and reuses an existing install", async (t) => {
  if (skipOnWindows(t)) return;
  const data = mkdtempSync(path.join(os.tmpdir(), "openbot-download-errors-"));
  const host = path.join(data, "host-main.cjs");
  const result = path.join(data, "result.json");
  writeFileSync(host, STOCK);
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const server = http.createServer((_req, res) => {
    res.writeHead(403);
    res.end("blocked");
  });
  t.after(() => server.close());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const common = {
    ...process.env,
    OPENBOT_HOST_MAIN: host,
    OPENBOT_SAND_DATA: data,
    OPENBOT_BOT_RESULT: result,
    OPENBOT_BOT_LOG: path.join(data, "install.log"),
    OPENBOT_BOT_PID: path.join(data, "install.pid"),
    OPENBOT_TARBALL: `http://127.0.0.1:${port}/codeload`,
    OPENBOT_ARCHIVE_TARBALL: `http://127.0.0.1:${port}/archive`,
    OPENBOT_COMMIT: "cafed00d",
    OPENBOT_SKIP_NPM_INSTALL: "1",
  };
  const failed = spawnSync("bash", [installSh, "--bot-mode-worker"], { encoding: "utf8", timeout: 30000, env: common });
  assert.notEqual(failed.status, 0);
  assert.match(JSON.parse(readFileSync(result, "utf8")).error, /codeload=403/);
  assert.match(JSON.parse(readFileSync(result, "utf8")).error, /github-archive=403/);

  mkdirSync(path.join(data, "openbot"), { recursive: true });
  writeFileSync(path.join(data, "openbot", "package.json"), "{}\n");
  const reused = spawnSync("bash", [installSh, "--bot-mode-worker"], { encoding: "utf8", timeout: 30000, env: { ...common, OPENBOT_TEST_DOWNLOAD_ONLY: "1" } });
  assert.equal(reused.status, 0, reused.stderr || reused.stdout);
  const state = JSON.parse(readFileSync(result, "utf8")) as { downloadSource: string; progress: { summary: string } };
  assert.equal(state.downloadSource, "existing-install");
  assert.equal(state.progress.summary, "download failed; reused existing install");
});

test("install.sh copies the tree, leaves the host stock, and starts the UI", async (t) => {
  if (skipOnWindows(t)) return;
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
    timeout: 45000,
    env: {
      ...process.env,
      OPENBOT_HOST_MAIN: hostMain,
      OPENBOT_SAND_DATA: sandData,
      OPENBOT_SRC: src,
      OPENBOT_DEST: path.join(sandData, "openbot"),
      OPENBOT_COMMIT: "cafed00d",
      OPENBOT_TUNNEL: "off",
      OPENBOT_SKIP_NPM_INSTALL: "1",
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
    const stamped = JSON.parse(readFileSync(path.join(sandData, "openbot", "payload", "version.json"), "utf8")) as {
      commit: string;
    };
    assert.equal(stamped.commit, "cafed00d");
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
    // Rebuilt control UI: brand, nav, and page-level copy.
    assert.match(app.body, /OpenBot/);
    assert.match(app.body, /Skip to content/);
    assert.match(app.body, /Dashboard/);
    assert.match(app.body, /Models/);
    assert.match(app.body, /Logs/);
    assert.match(app.body, /Set up your first provider/);
    assert.match(app.body, /Connect an OpenAI-compatible provider/);
    assert.match(app.body, /Switch to Official Grok/);
    assert.match(app.body, /Official Grok/);
    assert.match(app.body, /Add provider/);
    assert.match(app.body, /Fetch models/);
    assert.match(app.body, /Add model/);
    assert.match(app.body, /Save model/);
    assert.match(app.body, /Max output/);
    assert.match(app.body, /Reasoning/);
    assert.match(app.body, /Model catalog/);
    assert.match(app.body, /Recording/);
    assert.match(app.body, /Start tunnel/);
    assert.match(app.body, /127\.0\.0\.1:9280/);
    assert.match(app.body, /aria-modal/);
    // Pre-rebuild copy must be gone.
    assert.equal(app.body.includes("Start chatting"), false);
    assert.equal(app.body.includes("Use any model in Grok Bot"), false);
    assert.equal(app.body.includes("Choose a provider to continue"), false);
    assert.equal(app.body.includes("Your endpoint"), false);
    assert.equal(app.body.includes("Model ID"), false);
    assert.equal(app.body.includes("API Key"), false);
    assert.equal(app.body.includes("thinking-module"), false);
    assert.equal(app.body.includes("thinking-now-label"), false);
    assert.equal(app.body.includes("Default omits thinking fields"), false);
    assert.equal(app.body.includes("Record requests"), false);
    assert.equal(app.body.includes("<select"), false);
    assert.equal(app.body.includes("This chat"), false);
    assert.equal(app.body.includes("Use official Grok"), false);
    assert.equal(app.body.includes("Keys and model limits live here"), false);
    assert.equal(app.body.includes("Pick a model and a reasoning level"), false);
    const css = await get(`${UI}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.body, /#f7f7f4/);
    assert.match(css.body, /#f54e00/);
    assert.match(css.body, /--hairline/);
    assert.match(css.body, /--scrim/);
    assert.match(css.body, /\.dialog/);
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
      logSettings?: { loggingEnabled?: boolean };
    };
    assert.equal(parsed.snapshot.wrap.kind, "stock-unmarked");
    assert.equal(parsed.snapshot.uiListen.kind, "ours");
    assert.equal(parsed.snapshot.hopListen.kind, "ours");
    assert.equal(parsed.snapshot.uiListen.port, 9280);
    assert.equal(parsed.snapshot.hopListen.port, 9280);
    assert.equal("catalog" in parsed, false);
    assert.equal(parsed.logSettings?.loggingEnabled, false);
    const logsSettings = await get(`${UI}/api/logs/settings`);
    assert.equal(logsSettings.status, 200);
    assert.equal((JSON.parse(logsSettings.body) as { loggingEnabled: boolean }).loggingEnabled, false);
    const logsList = await get(`${UI}/api/logs`);
    assert.equal(logsList.status, 200);
    assert.equal((JSON.parse(logsList.body) as { total: number }).total, 0);

    const destCli = path.join(sandData, "openbot", "src", "cli.ts");
    const cliEnv = { ...process.env };
    delete cliEnv.OPENBOT_TUNNEL;
    const custom = spawnSync(
      "node",
      [
        "--experimental-strip-types",
        destCli,
        "install",
        "--host-main",
        hostMain,
        "--sand-data",
        sandData,
        "--origin",
        "https://example.invalid/v1",
        "--model",
        "glm-test",
        "--name",
        "Zhipu",
      ],
      {
        encoding: "utf8",
        timeout: 20000,
        env: {
          ...cliEnv,
          OPENBOT_HOST_MAIN: hostMain,
          OPENBOT_SAND_DATA: sandData,
          OPENBOT_API_KEY: "sk-test",
        },
      },
    );
    assert.equal(custom.status, 0, custom.stderr || custom.stdout);
    assert.equal(readFileSync(hostMain, "utf8").includes(OPENBOT_MARKER), true);
    assert.match(readFileSync(path.join(sandData, "openbot-mode"), "utf8"), /custom/);

    const update = spawnSync(
      "node",
      ["--experimental-strip-types", destCli, "install", "--host-main", hostMain, "--sand-data", sandData],
      {
        encoding: "utf8",
        timeout: 20000,
        env: {
          ...cliEnv,
          OPENBOT_HOST_MAIN: hostMain,
          OPENBOT_SAND_DATA: sandData,
        },
      },
    );
    assert.equal(update.status, 0, update.stderr || update.stdout);
    assert.equal(readFileSync(hostMain, "utf8").includes(OPENBOT_MARKER), true);
    assert.match(readFileSync(path.join(sandData, "openbot-mode"), "utf8"), /custom/);
  } finally {
    killPidFile(path.join(sandData, "openbot-ui.pid"));
    killPidFile(path.join(sandData, "openbot-hop.pid"));
  }
});
