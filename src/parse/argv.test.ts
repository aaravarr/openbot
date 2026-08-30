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
});
