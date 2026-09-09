import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const install = path.join(process.cwd(), "install.sh");

function runBash(script: string, args: string[] = []) {
  return execFileSync("bash", ["-c", script, "bash", ...args], { encoding: "utf8" });
}

function runStatus(data: string) {
  return execFileSync("bash", [install, "--bot-status"], {
    encoding: "utf8",
    env: { ...process.env, OPENBOT_SAND_DATA: data, OPENBOT_BOT_RESULT: path.join(data, "result.json") },
  });
}

test("bot-status reports missing, running, success, and failed result files", (t) => {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("bash is unavailable on this platform");
    return;
  }
  if (process.platform === "win32") {
    t.skip("bot-status shell behavior requires a POSIX runtime");
    return;
  }
  const data = mkdtempSync(path.join(os.tmpdir(), "openbot-install-result-"));
  const result = path.join(data, "result.json");
  try {
    assert.match(runStatus(data), /OPENBOT_STATUS=not-installed/);

    writeFileSync(result, JSON.stringify({ status: "running", startedAt: new Date().toISOString() }));
    assert.match(runStatus(data), /OPENBOT_STATUS=running/);

    writeFileSync(result, JSON.stringify({ status: "running", startedAt: "2026-09-09T09:00:00Z" }));
    assert.match(runStatus(data), /OPENBOT_WARNING=.*15 minutes/);

    writeFileSync(result, JSON.stringify({ status: "success", startedAt: "2026-09-09T10:00:00Z", finishedAt: "2026-09-09T10:01:00Z", url: "https://openbot.trycloudflare.com", qrPath: "/tmp/openbot.png" }));
    const success = runStatus(data);
    assert.match(success, /OPENBOT_STATUS=success/);
    assert.match(success, /OPENBOT_URL=https:\/\/openbot\.trycloudflare\.com/);

    writeFileSync(result, JSON.stringify({ status: "failed", startedAt: "2026-09-09T10:00:00Z", finishedAt: "2026-09-09T10:01:00Z", error: "boom", logTail: "last line" }));
    const failed = runStatus(data);
    assert.match(failed, /OPENBOT_STATUS=failed/);
    assert.match(failed, /OPENBOT_ERROR=boom/);
    assert.match(failed, /OPENBOT_LOG_TAIL=last line/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("bot-mode guards duplicate workers and cleans stale pid files", (t) => {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("bash is unavailable on this platform");
    return;
  }
  if (process.platform === "win32") {
    t.skip("detached-process behavior requires a POSIX shell path");
    return;
  }

  const data = mkdtempSync(path.join(os.tmpdir(), "openbot-bot-mode-"));
  try {
    const guard = "eval \\\"$(sed -n '/^bot_pid_running()/,/^}/p' \\\"$1\\\")\\\"; bot_pid_running";
    const worker = Number(runBash("bash -c 'sleep 20' --bot-mode-worker & echo $!").trim());
    const pidFile = path.join(data, "worker.pid");
    writeFileSync(pidFile, String(worker) + "\\n");
    assert.doesNotThrow(() => runBash(guard, [install, pidFile]));

    writeFileSync(pidFile, "999999\\n");
    assert.throws(() => runBash(guard, [install, pidFile]));
    rmSync(pidFile, { force: true });
    assert.equal(readFileSync(install, "utf8").includes("rm -f \\\"$BOT_PID_FILE\\\""), true);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("bot-mode returns immediately before requiring Node and preserves default args", (t) => {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("bash is unavailable on this platform");
    return;
  }

  const source = readFileSync(install, "utf8");
  assert.ok(source.includes("bash -euo pipefail -c"));
  assert.ok(source.includes("$!"));
  assert.ok(source.includes("install_main \"$@\""));

  if (process.platform === "win32") {
    t.skip("detached-process behavior requires a POSIX shell path");
    return;
  }

  const data = mkdtempSync(path.join(os.tmpdir(), "openbot-bot-mode-immediate-"));
  try {
    const result = path.join(data, "result.json");
    const started = execFileSync("bash", [install, "--bot-mode"], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        OPENBOT_HOST_MAIN: path.join(data, "missing-host.cjs"),
        OPENBOT_SAND_DATA: data,
        OPENBOT_BOT_RESULT: result,
        OPENBOT_BOT_LOG: path.join(data, "install.log"),
        OPENBOT_BOT_PID: path.join(data, "install.pid"),
      },
    });
    assert.match(started, /OPENBOT_STATUS=started/);
    assert.equal(JSON.parse(readFileSync(result, "utf8")).status, "running");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
