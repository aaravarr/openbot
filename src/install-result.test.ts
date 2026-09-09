import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const install = path.join(process.cwd(), "install.sh");

function runBash(script: string, args: string[] = []) {
  return execFileSync("bash", ["-c", script, "bash", ...args], { encoding: "utf8" });
}

function runGuard(guard: string, pidFile: string) {
  return runBash("BOT_PID_FILE=$2; " + guard + "; bot_pid_running; echo EXIT=$?", ["bash", pidFile]);
}

function runStatus(data: string) {
  return execFileSync("bash", [install, "--bot-status"], {
    encoding: "utf8",
    env: { ...process.env, OPENBOT_SAND_DATA: data, OPENBOT_BOT_RESULT: path.join(data, "result.json") },
  });
}

function requireBash(t: object) {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
  } catch {
    (t as { skip: (reason: string) => void }).skip("bash is unavailable on this platform");
    return false;
  }
  return true;
}

function skipOnWindows(t: object) {
  if (process.platform !== "win32") return false;
  (t as { skip: (reason: string) => void }).skip("shell behavior requires a POSIX runtime");
  return true;
}

// bot_pid_running lives at the top of install.sh. Extracting it here in
// TypeScript avoids a second quoting layer; passing an embedded sed script
// through execFileSync corrupted the quotes and broke the guard under CI.
function installGuardFunction() {
  const source = readFileSync(install, "utf8");
  const match = source.match(/^bot_pid_running\(\) \{[\s\S]*?^\}/m);
  assert.ok(match, "install.sh must define bot_pid_running");
  return match[0];
}

function botModeEnv(data: string, result: string, log: string, pidFile: string) {
  return {
    ...process.env,
    OPENBOT_HOST_MAIN: path.join(data, "missing-host.cjs"),
    OPENBOT_SAND_DATA: data,
    OPENBOT_BOT_RESULT: result,
    OPENBOT_BOT_LOG: log,
    OPENBOT_BOT_PID: pidFile,
  };
}

test("bot-status reports missing, running, success, and failed result files", (t) => {
  if (!requireBash(t) || skipOnWindows(t)) return;

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

test("bot-mode guards duplicate workers and cleans stale pid files", async (t) => {
  if (!requireBash(t) || skipOnWindows(t)) return;

  const data = mkdtempSync(path.join(os.tmpdir(), "openbot-bot-mode-"));
  const guard = installGuardFunction();
  const pidFile = path.join(data, "install.pid");
  // A worker that does not hold the stdout/stderr pipes open, so execFileSync
  // does not block on the child, and whose argv advertises --bot-mode-worker.
  const worker = spawn("bash", ["-c", "exec -a --bot-mode-worker sleep 60"], {
    stdio: "ignore",
    detached: true,
  });
  t.after(() => {
    try {
      worker.kill("SIGKILL");
    } catch {}
  });
  try {
    // A live worker pid makes the guard return success (no duplicate start).
    writeFileSync(pidFile, String(worker.pid) + "\n");
    assert.match(runGuard(guard, pidFile).trim(), /EXIT=0$/);

    // Once the worker is dead, the same stale pid file must fail the guard.
    worker.kill("SIGKILL");
    worker.unref();
    await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    assert.equal(
      runBash("kill -0 $1 2>/dev/null && echo live || echo dead", ["bash", String(worker.pid)]).trim(),
      "dead"
    );
    assert.match(runGuard(guard, pidFile).trim(), /EXIT=1$/);

    // A dead pid is cleaned up, a fresh --bot-mode run starts, and the pid file
    // is rewritten with a real newline so the numeric guard can match it.
    const result = path.join(data, "result.json");
    const started = execFileSync("bash", [install, "--bot-mode"], {
      encoding: "utf8",
      timeout: 5000,
      env: botModeEnv(data, result, path.join(data, "install.log"), pidFile),
    });
    assert.match(started, /OPENBOT_STATUS=started/);
    assert.equal(JSON.parse(readFileSync(result, "utf8")).status, "running");
    assert.match(readFileSync(pidFile, "utf8"), /^[0-9]+\n$/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("bot-mode returns immediately before requiring Node and preserves default args", (t) => {
  if (!requireBash(t)) return;

  const source = readFileSync(install, "utf8");
  assert.ok(source.includes("bash -euo pipefail -c"));
  assert.ok(source.includes("printf '%s\\n' \"$!\""));
  assert.ok(source.includes("install_main \"$@\""));

  if (skipOnWindows(t)) return;

  const data = mkdtempSync(path.join(os.tmpdir(), "openbot-bot-mode-immediate-"));
  try {
    const result = path.join(data, "result.json");
    const started = execFileSync("bash", [install, "--bot-mode"], {
      encoding: "utf8",
      timeout: 5000,
      env: botModeEnv(data, result, path.join(data, "install.log"), path.join(data, "install.pid")),
    });
    assert.match(started, /OPENBOT_STATUS=started/);
    assert.equal(JSON.parse(readFileSync(result, "utf8")).status, "running");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
