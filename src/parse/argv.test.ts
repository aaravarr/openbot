import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { HIGH_AGENT_MAX_TOKENS, loopbackExpose, type Catalog } from "../domain/types.ts";
import { makeModel } from "../domain/model.ts";
import { parseModelId, parseModelSlug } from "../supervisor/plan.ts";
import { boxPathsFrom } from "../supervisor/paths.ts";
import { parseProviderId } from "../supervisor/secrets.ts";
import { boxFromSavedMode, parseInstallCommand, parseUpstreamOrigin, repoRootFromMeta } from "./argv.ts";

function testPaths() {
  return boxPathsFrom({ repoRoot: "/tmp/openbot", sandData: "/tmp/openbot-data" });
}

function zhipuCatalog(): Catalog {
  const providerId = parseProviderId("zhipu");
  const modelId = parseModelId("zhipu:glm-5.3-flash");
  return {
    providers: [
      {
        id: providerId,
        name: "Zhipu",
        origin: parseUpstreamOrigin("https://open.bigmodel.cn/api/paas/v4"),
        maxTokensDefault: HIGH_AGENT_MAX_TOKENS,
        mapFile: "provider-maps.cjs",
      },
    ],
    models: [makeModel({ id: modelId, providerId, slug: parseModelSlug("glm-5.3-flash") })],
    bindings: [{ conversation: { kind: "wildcard" }, modelId }],
  };
}

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

test("boxFromSavedMode keeps custom wrap when mode is custom", () => {
  const box = boxFromSavedMode({
    paths: testPaths(),
    mode: "custom\n",
    catalog: zhipuCatalog(),
    expose: loopbackExpose(),
  });
  assert.equal(box.kind, "custom");
  if (box.kind === "custom") {
    assert.equal(box.catalog.models.length, 1);
  }
});

test("boxFromSavedMode keeps official when mode is official even if the plan has models", () => {
  const box = boxFromSavedMode({
    paths: testPaths(),
    mode: "official",
    catalog: zhipuCatalog(),
    expose: { kind: "cloudflare-quick" },
  });
  assert.equal(box.kind, "official");
  assert.equal(box.expose.kind, "cloudflare-quick");
});

test("boxFromSavedMode infers custom from a catalog when mode is missing", () => {
  const box = boxFromSavedMode({
    paths: testPaths(),
    mode: undefined,
    catalog: zhipuCatalog(),
    expose: loopbackExpose(),
  });
  assert.equal(box.kind, "custom");
});

test("boxFromSavedMode is official on a first install with no models", () => {
  const box = boxFromSavedMode({
    paths: testPaths(),
    mode: undefined,
    catalog: { providers: [], models: [], bindings: [] },
    expose: loopbackExpose(),
  });
  assert.equal(box.kind, "official");
});
