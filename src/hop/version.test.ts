import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const versionCjs = path.join(repoRoot, "payload", "version.cjs");

function envWithoutCommit(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENBOT_COMMIT;
  return env;
}

function printVersion(file: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["-e", `console.log(require(${JSON.stringify(file)}).openBotVersion())`], {
    env,
    encoding: "utf8",
  });
}

function printApplied(file: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    ["-e", `console.log(JSON.stringify(require(${JSON.stringify(file)}).applyOpenBotVersionHeader({})))`],
    { env, encoding: "utf8" },
  );
}

test("openBotVersion prefers OPENBOT_COMMIT over git", () => {
  const result = printVersion(versionCjs, { ...process.env, OPENBOT_COMMIT: "cafed00d" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "cafed00d");
});

test("openBotVersion reads payload/version.json when env is unset", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-version-"));
  const copied = path.join(dir, "version.cjs");
  copyFileSync(versionCjs, copied);
  writeFileSync(path.join(dir, "version.json"), JSON.stringify({ commit: "abc1234deadbeef" }) + "\n");
  const result = printVersion(copied, envWithoutCommit());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "abc1234deadbeef");
});

test("openBotVersion falls back to git HEAD beside payload/", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "openbot-version-git-"));
  const payload = path.join(repo, "payload");
  mkdirSync(payload);
  copyFileSync(versionCjs, path.join(payload, "version.cjs"));
  writeFileSync(path.join(repo, "README"), "stamp");
  const gitEnv = {
    ...envWithoutCommit(),
    GIT_AUTHOR_NAME: "OpenBot",
    GIT_AUTHOR_EMAIL: "openbot@example.invalid",
    GIT_COMMITTER_NAME: "OpenBot",
    GIT_COMMITTER_EMAIL: "openbot@example.invalid",
  };
  assert.equal(spawnSync("git", ["init"], { cwd: repo, env: gitEnv, encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", ["add", "."], { cwd: repo, env: gitEnv, encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-m", "stamp"], { cwd: repo, env: gitEnv, encoding: "utf8" }).status, 0);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, env: gitEnv, encoding: "utf8" });
  assert.equal(head.status, 0, head.stderr);
  const result = printVersion(path.join(payload, "version.cjs"), envWithoutCommit());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), head.stdout.trim());
});

test("openBotVersion is unknown without stamp, git, or env", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-version-none-"));
  const copied = path.join(dir, "version.cjs");
  copyFileSync(versionCjs, copied);
  const result = printVersion(copied, envWithoutCommit());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "unknown");
});

test("applyOpenBotVersionHeader sets x-openbot-version and does not invent User-Agent", () => {
  const result = printApplied(versionCjs, { ...process.env, OPENBOT_COMMIT: "cafed00d" });
  assert.equal(result.status, 0, result.stderr);
  const headers = JSON.parse(result.stdout) as Record<string, string>;
  assert.equal(headers["x-openbot-version"], "cafed00d");
  assert.equal(headers["User-Agent"], undefined);
  assert.equal(headers["user-agent"], undefined);
});
