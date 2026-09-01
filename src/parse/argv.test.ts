import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseInstallCommand, repoRootFromMeta } from "./argv.ts";

test("refuses an API key on argv", () => {
  assert.throws(
    () =>
      parseInstallCommand({
        argv: ["install", "--api-key", "sk-live"],
        env: {},
        repoRoot: "/tmp/openbot",
      }),
    /command line/,
  );
});

test("census-only and dry-run cannot be combined", () => {
  assert.throws(
    () =>
      parseInstallCommand({
        argv: ["--census-only", "--dry-run"],
        env: {},
        repoRoot: "/tmp/openbot",
      }),
    /pick one/,
  );
});

test("install with origin reads OPENBOT_API_KEY from env", () => {
  const parsed = parseInstallCommand({
    argv: ["install", "--origin", "https://open.bigmodel.cn/api/paas/v4", "--model", "glm-5.3-flash", "--name", "Zhipu"],
    env: { OPENBOT_API_KEY: "sk-test" },
    repoRoot: "/tmp/openbot",
  });
  assert.equal(parsed.command.kind, "install");
  if (parsed.command.kind === "install") {
    assert.equal(parsed.command.custom?.modelSlug, "glm-5.3-flash");
    assert.equal(parsed.command.custom?.secret, "sk-test");
    assert.equal(parsed.command.exposeSpecified, false);
    assert.equal(parsed.command.expose.kind, "loopback");
  }
});

test("bare install is official plus UI, not a custom wrap", () => {
  const parsed = parseInstallCommand({
    argv: ["install"],
    env: {},
    repoRoot: "/tmp/openbot",
  });
  assert.equal(parsed.command.kind, "install");
  if (parsed.command.kind === "install") {
    assert.equal(parsed.command.custom, undefined);
    assert.equal(parsed.command.exposeSpecified, false);
  }
});

test("--tunnel off marks expose as specified loopback", () => {
  const parsed = parseInstallCommand({
    argv: ["install", "--tunnel", "off"],
    env: {},
    repoRoot: "/tmp/openbot",
  });
  assert.equal(parsed.command.kind, "install");
  if (parsed.command.kind === "install") {
    assert.equal(parsed.command.exposeSpecified, true);
    assert.equal(parsed.command.expose.kind, "loopback");
  }
});

test("OPENBOT_TUNNEL=cloudflare marks expose as specified", () => {
  const parsed = parseInstallCommand({
    argv: ["install"],
    env: { OPENBOT_TUNNEL: "cloudflare" },
    repoRoot: "/tmp/openbot",
  });
  assert.equal(parsed.command.kind, "install");
  if (parsed.command.kind === "install") {
    assert.equal(parsed.command.exposeSpecified, true);
    assert.equal(parsed.command.expose.kind, "cloudflare-quick");
  }
});

test("tunnel on is a tunnel command", () => {
  const parsed = parseInstallCommand({
    argv: ["tunnel", "on"],
    env: {},
    repoRoot: "/tmp/openbot",
  });
  assert.equal(parsed.command.kind, "tunnel");
  if (parsed.command.kind === "tunnel") {
    assert.equal(parsed.command.action, "on");
  }
});

test("cli file URL resolves to the directory that contains src/", () => {
  const metaUrl = pathToFileURL("/tmp/openbot-pkg/src/cli.ts").href;
  assert.equal(repoRootFromMeta(metaUrl), "/tmp/openbot-pkg");
  const parsed = parseInstallCommand({
    argv: ["install"],
    env: {},
    metaUrl,
  });
  assert.equal(parsed.paths.repoRoot, "/tmp/openbot-pkg");
  assert.equal(parsed.paths.uiServer, "/tmp/openbot-pkg/src/ui/server.ts");
  assert.equal(parsed.paths.expose, "/home/box/sand-data/openbot-expose");
  assert.equal(parsed.paths.logsSettings, "/home/box/sand-data/openbot-logs.json");
  assert.equal(parsed.paths.requestLog, "/home/box/sand-data/openbot-requests.jsonl");
  assert.equal(parsed.paths.requestBodiesDir, "/home/box/sand-data/openbot-request-bodies");
});
