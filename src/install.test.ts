import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OPENBOT_MARKER } from "./domain/types.ts";
import { payloadFingerprint } from "./host/payload-fingerprint.ts";
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

function runInstall(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [installSh, ...args], { env, timeout: 30000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
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
  const run = await runInstall(["--bot-mode-worker"], {
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
  const failed = await runInstall(["--bot-mode-worker"], common);
  assert.notEqual(failed.status, 0);
  assert.match(JSON.parse(readFileSync(result, "utf8")).error, /codeload=403/);
  assert.match(JSON.parse(readFileSync(result, "utf8")).error, /github-archive=403/);

  mkdirSync(path.join(data, "openbot"), { recursive: true });
  writeFileSync(path.join(data, "openbot", "package.json"), "{}\n");
  const reused = await runInstall(["--bot-mode-worker"], { ...common, OPENBOT_TEST_DOWNLOAD_ONLY: "1" });
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

test("bot-mode defers the host bounce and ends the caller's turn only when idle", async (t) => {
  if (skipOnWindows(t)) return;
  const box = mkdtempSync(path.join(os.tmpdir(), "openbot-bounce-box-"));
  const sandHost = path.join(box, "sand-host");
  const sandData = path.join(box, "sand-data");
  const deployed = path.join(sandData, "openbot");
  const hostMain = path.join(sandHost, "host-main.cjs");
  const sentinel = path.join(box, "sigterm.sentinel");
  const marker = path.join(sandData, "openbot-pending-bounce.json");
  const result = path.join(sandData, "result.json");
  const log = path.join(sandData, "install.log");
  mkdirSync(sandHost, { recursive: true });
  mkdirSync(sandData);
  writeFileSync(hostMain, STOCK);
  seedCustomBox(sandData);
  writeFakeCloudflared(sandData, "https://deferred-bounce.trycloudflare.com");
  const hostPid = startFakeHost(sandHost, sentinel);
  const installEnv = {
    ...process.env,
    OPENBOT_HOST_MAIN: hostMain,
    OPENBOT_SAND_DATA: sandData,
    OPENBOT_BOT_RESULT: result,
    OPENBOT_BOT_LOG: log,
    OPENBOT_BOT_PID: path.join(sandData, "install.pid"),
    OPENBOT_SRC: repoRoot,
    OPENBOT_DEST: deployed,
    OPENBOT_COMMIT: "cafed00d",
    OPENBOT_TUNNEL: "off",
    OPENBOT_SKIP_NPM_INSTALL: "1",
  };
  t.after(() => {
    killPidFiles([
      path.join(sandData, "openbot-ui.pid"),
      path.join(sandData, "openbot-hop.pid"),
      path.join(sandData, "openbot-guard.pid"),
      path.join(sandData, "openbot-finalize.pid"),
      path.join(sandData, "openbot-tunnel.pid"),
    ]);
    try {
      process.kill(hostPid, "SIGKILL");
    } catch {
      /* already gone */
    }
    rmSync(box, { recursive: true, force: true });
  });

  const started = await runInstall(["--bot-mode"], installEnv);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /OPENBOT_STATUS=started/);
  const state = await waitForStatus(result, "success");
  assert.equal(state.hostBounce, "pending");

  // G1: the host that runs the caller's turn is still alive and was never
  // signalled while the install reported success.
  assert.equal(pidAlive(hostPid), true, "the calling host must survive the install");
  assert.equal(existsSync(sentinel), false, "the calling host must never receive SIGTERM during the install");
  assert.equal(existsSync(marker), true, "the deferred bounce must be armed");
  assert.match(readFileSync(log, "utf8"), /OPENBOT_HOST_BOUNCE=pending/);

  const status = spawnSync("bash", [installSh, "--bot-status"], {
    encoding: "utf8",
    env: { ...installEnv, OPENBOT_SAND_DATA: sandData, OPENBOT_BOT_RESULT: result },
  });
  assert.match(status.stdout, /OPENBOT_HOST_BOUNCE=pending/);
  assert.match(status.stdout, /restart itself once it is idle/);

  // G4: a second reconcile inside the window (the worker's own tunnel step,
  // replayed by hand) must not bounce the host or clear the marker.
  const before = readFileSync(marker, "utf8");
  const tunnel = runCli({
    deployed,
    args: ["tunnel", "on", "--json"],
    hostMain,
    sandData,
    env: { ...process.env, OPENBOT_TUNNEL: "cloudflare" },
  });
  assert.equal(tunnel.status, 0, tunnel.stderr || tunnel.stdout);
  assert.equal(existsSync(sentinel), false, "a second reconcile must not bounce the caller");
  assert.equal(readFileSync(marker, "utf8"), before, "the marker must survive a second reconcile");

  // The worker detached a finalizer at install time. Stop it so this test
  // decides exactly when the bounce lands; the spawn itself is asserted above
  // through the pidfile.
  killPidFile(path.join(sandData, "openbot-finalize.pid"));
  rmSync(path.join(sandData, "openbot-finalize.pid"), { force: true });

  // The armed marker must describe the payload that is now on disk; a mismatch
  // would make the finalizer retire it silently instead of bouncing.
  const fingerprint = deployedFingerprint(deployed);
  const armed = JSON.parse(readFileSync(marker, "utf8")) as { armedAtMs: number; fingerprint: string };
  assert.equal(armed.fingerprint, fingerprint, "the marker must name the deployed payload");
  const cliEnv = { ...process.env };

  // G2: a fresh in-flight turn is never interrupted, not even by --force.
  const now = Date.now();
  writeFileSync(
    path.join(sandData, "openbot-turn-lease.json"),
    `${JSON.stringify({ active: 1, lastStartAt: now, lastEndAt: now, lastFinishReason: "tool_calls", updatedAt: now })}\n`,
  );
  // --grace-ms has a 1000 ms floor (a smaller value could delete the idle
  // protection), so the grace window is waited out here to isolate the
  // in-flight request as the only thing holding the bounce.
  await sleep(1200);
  const forced = runCli({
    deployed,
    args: ["finalize-host", "--once", "--force", "--grace-ms", "1000", "--max-wait-ms", "1"],
    hostMain,
    sandData,
    env: cliEnv,
  });
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /still waiting \(turn-active\)/);
  assert.equal(existsSync(sentinel), false, "force must never end a request that is in flight");
  assert.equal(existsSync(marker), true);

  // G3: once the turn is over and the quiet window passed, the finalizer
  // applies the bounce: the host receives SIGTERM, the sentinel appears, the
  // marker is cleared and the status reports done. The grace window is a
  // product flag (default 120 s), so G3 shortens it instead of rewriting the
  // marker: rewriting armedAt would also mask the stamp-mismatch path.
  writeFileSync(
    path.join(sandData, "openbot-turn-lease.json"),
    `${JSON.stringify({ active: 0, lastStartAt: now - 3_600_000, lastEndAt: now - 3_600_000, lastFinishReason: "stop", updatedAt: now - 3_600_000 })}\n`,
  );
  await sleep(1200);
  const applied = runCli({
    deployed,
    args: [
      "finalize-host",
      "--once",
      "--grace-ms",
      "1000",
      "--wait-idle-ms",
      "1000",
      "--busy-wait-ms",
      "1000",
      "--max-wait-ms",
      "600000",
    ],
    hostMain,
    sandData,
    env: cliEnv,
  });
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /bounce applied/);
  for (let i = 0; i < 40 && !existsSync(sentinel); i++) {
    await sleep(100);
  }
  assert.equal(existsSync(sentinel), true, "the idle finalizer must SIGTERM the stale host");
  assert.equal(existsSync(marker), false, "the applied marker must be cleared");
  const done = spawnSync("bash", [installSh, "--bot-status"], {
    encoding: "utf8",
    env: { ...installEnv, OPENBOT_SAND_DATA: sandData, OPENBOT_BOT_RESULT: result },
  });
  assert.match(done.stdout, /OPENBOT_HOST_BOUNCE=done/);
});

test("a bot-mode install that never reaches success still leaves the host alive", async (t) => {
  if (skipOnWindows(t)) return;
  const box = mkdtempSync(path.join(os.tmpdir(), "openbot-bounce-fail-"));
  const sandHost = path.join(box, "sand-host");
  const sandData = path.join(box, "sand-data");
  const hostMain = path.join(sandHost, "host-main.cjs");
  const sentinel = path.join(box, "sigterm.sentinel");
  const result = path.join(sandData, "result.json");
  mkdirSync(sandHost, { recursive: true });
  mkdirSync(sandData);
  writeFileSync(hostMain, STOCK);
  seedCustomBox(sandData);
  // A tunnel that never yields a usable URL: the worker must fail after the
  // reconcile already armed the deferred bounce.
  writeFakeCloudflared(sandData, "https://not-a-tunnel.example.com");
  const hostPid = startFakeHost(sandHost, sentinel);
  const installEnv = {
    ...process.env,
    OPENBOT_HOST_MAIN: hostMain,
    OPENBOT_SAND_DATA: sandData,
    OPENBOT_BOT_RESULT: result,
    OPENBOT_BOT_LOG: path.join(sandData, "install.log"),
    OPENBOT_BOT_PID: path.join(sandData, "install.pid"),
    OPENBOT_SRC: repoRoot,
    OPENBOT_DEST: path.join(sandData, "openbot"),
    OPENBOT_COMMIT: "cafed00d",
    OPENBOT_TUNNEL: "off",
    OPENBOT_SKIP_NPM_INSTALL: "1",
  };
  t.after(() => {
    killPidFiles([
      path.join(sandData, "openbot-ui.pid"),
      path.join(sandData, "openbot-hop.pid"),
      path.join(sandData, "openbot-guard.pid"),
      path.join(sandData, "openbot-finalize.pid"),
      path.join(sandData, "openbot-tunnel.pid"),
    ]);
    try {
      process.kill(hostPid, "SIGKILL");
    } catch {
      /* already gone */
    }
    rmSync(box, { recursive: true, force: true });
  });

  const started = await runInstall(["--bot-mode"], installEnv);
  assert.equal(started.status, 0, started.stderr);
  const state = await waitForStatus(result, "failed");
  assert.equal(state.status, "failed");
  assert.equal(existsSync(sentinel), false, "a failed install must not bounce the caller either");
  assert.equal(pidAlive(hostPid), true);
  // The host file was rewritten before the tunnel failed, so the bounce stays
  // armed: the box must not be stranded on the previous payload.
  assert.equal(existsSync(path.join(sandData, "openbot-pending-bounce.json")), true);
  assert.equal(existsSync(path.join(sandData, "openbot-finalize.pid")), true);
});


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll the bot result file until it reaches a terminal status. */
async function waitForStatus(file: string, want: "success" | "failed", timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (last.status === want) return last;
      if (last.status === "failed" && want === "success") {
        throw new Error(`install failed: ${String(last.error)} (${readFileSync(file, "utf8")})`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("install failed")) throw err;
    }
    await sleep(250);
  }
  throw new Error(`install never reached ${want}: ${JSON.stringify(last)}`);
}

/** A fake cloudflared: ensureCloudflared only checks that the file exists. */
function writeFakeCloudflared(data: string, url: string): void {
  const bin = path.join(data, "bin", "cloudflared");
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' '${url}'\nsleep 600\n`);
  chmodSync(bin, 0o755);
}

/**
 * A fake host with a real host-main.cjs argv: the preload keeps the process
 * alive and writes a sentinel on SIGTERM, so "the caller was never signalled"
 * is proven by the sentinel's absence rather than by the process still running
 * (the app relaunches a killed host, which would hide the failure).
 */
function startFakeHost(sandHost: string, sentinel: string): number {
  const preload = path.join(sandHost, "sigterm-sentinel.cjs");
  writeFileSync(
    preload,
    [
      "const fs = require('fs');",
      "const file = process.env.OPENBOT_TEST_SIG_FILE;",
      "process.on('SIGTERM', () => {",
      "  try { if (file) fs.writeFileSync(file, 'sigterm\\n'); } catch (err) {}",
      "  process.exit(0);",
      "});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  const child = spawn(process.execPath, ["--require", preload, path.join(sandHost, "host-main.cjs")], {
    env: { ...process.env, OPENBOT_TEST_SIG_FILE: sentinel },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  assert.ok(child.pid !== undefined, "fake host must start");
  return child.pid ?? 0;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function deployedFingerprint(deployed: string): string {
  return payloadFingerprint({
    payloadDir: path.join(deployed, "payload"),
    read: (file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    },
  });
}

/**
 * Every cli.ts call takes --host-main/--sand-data explicitly: the CLI falls
 * back to /home/box/... and would refuse with host-missing on a box installed
 * anywhere else.
 */
/**
 * A box that is already OpenBot-custom. The deferred-bounce path only exists
 * for a custom desired state: an official reconcile never rewrites the host
 * file, so there would be no wrap change to defer (verified on Linux).
 */
function seedCustomBox(sandData: string): void {
  writeFileSync(path.join(sandData, "openbot-mode"), "custom\n");
  writeFileSync(
    path.join(sandData, "openbot-plan.json"),
    `${JSON.stringify({
      kind: "custom",
      catalog: {
        providers: [
          {
            id: "fixture",
            name: "Fixture",
            origin: "https://example.invalid/v1",
            maxTokensDefault: 65536,
            mapFile: "provider-maps.cjs",
          },
        ],
        models: [{ id: "fixture:m", providerId: "fixture", slug: "m", parameters: [] }],
        bindings: [{ conversation: { kind: "wildcard" }, modelId: "fixture:m" }],
      },
    })}\n`,
  );
}

function runCli(input: {
  deployed: string;
  args: string[];
  hostMain: string;
  sandData: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}) {
  return spawnSync(
    "node",
    [
      "--experimental-strip-types",
      path.join(input.deployed, "src", "cli.ts"),
      ...input.args,
      "--host-main",
      input.hostMain,
      "--sand-data",
      input.sandData,
    ],
    { encoding: "utf8", timeout: input.timeout ?? 60_000, env: input.env ?? process.env },
  );
}

function killPidFiles(files: string[]): void {
  for (const file of files) {
    killPidFile(file);
  }
}


