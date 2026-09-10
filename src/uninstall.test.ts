import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.join(process.cwd(), "uninstall.sh");

test("uninstall script has the required destructive-action guards and bot protocol", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /OPENBOT_STATUS=started/);
  assert.match(source, /status.*running/);
  assert.match(source, /OPENBOT_BOT_INSTRUCTION=SendToUser now: 卸载已开始/);
  assert.match(source, /expected a \/sand-data path/);
  assert.equal(source.includes("rm -rf $HOME"), false);
  assert.equal(source.includes("rm -rf \"/\""), false);
  assert.match(source, /Provider secrets retained/);
  assert.match(source, /foreign process; it was not killed/);
});

function requireBash(t: object): boolean {
  try { execFileSync("bash", ["--version"], { stdio: "ignore" }); }
  catch { (t as { skip: (reason: string) => void }).skip("bash is unavailable"); return false; }
  if (process.platform === "win32") { (t as { skip: (reason: string) => void }).skip("POSIX process behavior is unavailable on Windows"); return false; }
  return true;
}

function run(scriptArgs: string[], data: string, host: string): string {
  return execFileSync("bash", [script, ...scriptArgs], {
    encoding: "utf8",
    env: { ...process.env, OPENBOT_SAND_DATA: data, OPENBOT_HOST_MAIN: host },
    timeout: 10000,
  });
}

test("uninstall bot result protocol and safety checks", (t) => {
  if (!requireBash(t)) return;
  const root = mkdtempSync(path.join(os.tmpdir(), "openbot-uninstall-"));
  const data = path.join(root, "sand-data");
  const hostDir = path.join(root, "sand-host");
  const host = path.join(hostDir, "host-main.cjs");
  try {
    mkdirSync(data, { recursive: true }); mkdirSync(hostDir, { recursive: true });
    writeFileSync(host, "stock host\n"); writeFileSync(`${host}.pre-openbot`, "stock host\n");
    writeFileSync(path.join(data, "secrets.json"), "{\"key\":\"keep\"}\n");
    mkdirSync(path.join(data, "openbot")); mkdirSync(path.join(data, "node22"));
    writeFileSync(path.join(data, "openbot-mode"), "official\n"); writeFileSync(path.join(data, "openbot-plan.json"), "{}\n");
    const output = run(["--yes"], data, host);
    assert.match(output, /official mode/);
    assert.match(output, /9280 is not listening/);
    assert.equal(readFileSync(host, "utf8"), "stock host\n");
    assert.equal(readFileSync(path.join(data, "secrets.json"), "utf8"), "{\"key\":\"keep\"}\n");
    assert.equal(JSON.stringify(readFileSync(path.join(data, "openbot-uninstall-result.json"), "utf8")).includes("success"), false);
    run(["--yes", "--purge-secrets"], data, host);
    assert.throws(() => readFileSync(path.join(data, "secrets.json")));
    run(["--yes"], data, host);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uninstall stops the owned UI, preserves a foreign listener, and reports bot state", async (t) => {
  if (!requireBash(t)) return;
  const root = mkdtempSync(path.join(os.tmpdir(), "openbot-uninstall-ui-"));
  const data = path.join(root, "sand-data"); const hostDir = path.join(root, "sand-host"); const host = path.join(hostDir, "host-main.cjs");
  const ui = path.join(root, "src", "ui", "server.ts"); const foreign = path.join(root, "foreign.js");
  let owned: ReturnType<typeof spawn> | undefined; let foreignProc: ReturnType<typeof spawn> | undefined;
  try {
    mkdirSync(path.dirname(ui), { recursive: true }); mkdirSync(data, { recursive: true }); mkdirSync(hostDir, { recursive: true });
    writeFileSync(host, "wrapped host\n"); writeFileSync(`${host}.pre-openbot`, "stock host\n");
    writeFileSync(ui, "require('http').createServer((q,s)=>s.end('ui')).listen(9280,'127.0.0.1');\n");
    writeFileSync(foreign, "require('http').createServer((q,s)=>s.end('foreign')).listen(9280,'127.0.0.1');\n");
    owned = spawn(process.execPath, [ui], { stdio: "ignore" }); writeFileSync(path.join(data, "openbot-ui.pid"), `${owned.pid}\n`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const started = execFileSync("bash", [script, "--bot-mode"], { encoding: "utf8", env: { ...process.env, OPENBOT_SAND_DATA: data, OPENBOT_HOST_MAIN: host }, timeout: 5000 });
    assert.match(started, /OPENBOT_STATUS=started/); assert.match(started, /卸载已开始/);
    for (let i = 0; i < 50; i++) { await new Promise((resolve) => setTimeout(resolve, 100)); const state = JSON.parse(readFileSync(path.join(data, "openbot-uninstall-result.json"), "utf8")); if (state.status === "success") break; }
    assert.equal(readFileSync(host, "utf8"), "stock host\n");
    assert.equal(owned.exitCode === null, false);
    assert.match(execFileSync("bash", [script, "--bot-status"], { encoding: "utf8", env: { ...process.env, OPENBOT_SAND_DATA: data, OPENBOT_HOST_MAIN: host } }), /OPENBOT_STATUS=success/);
    foreignProc = spawn(process.execPath, [foreign], { stdio: "ignore" }); await new Promise((resolve) => setTimeout(resolve, 250));
    run(["--yes"], data, host);
    assert.equal(foreignProc.exitCode, null);
  } finally { owned?.kill("SIGTERM"); foreignProc?.kill("SIGTERM"); rmSync(root, { recursive: true, force: true }); }
});
