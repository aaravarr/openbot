import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const install = path.join(process.cwd(), "install.sh");

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
