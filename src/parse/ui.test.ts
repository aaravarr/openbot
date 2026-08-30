import assert from "node:assert/strict";
import test from "node:test";
import { parseUiProviderSave } from "./ui.ts";
import { boxPathsFrom } from "../supervisor/paths.ts";

test("UI custom save keeps the secret off DesiredState", () => {
  const paths = boxPathsFrom({ repoRoot: "/tmp/openbot", sandData: "/tmp/openbot-data" });
  const parsed = parseUiProviderSave(
    {
      kind: "custom",
      name: "Zhipu",
      origin: "https://open.bigmodel.cn/api/paas/v4",
      modelSlug: "glm-5.3-flash",
      secret: "sk-live",
    },
    paths,
  );
  assert.equal(parsed.desired.kind, "custom");
  assert.equal("secret" in parsed.desired, false);
  if (parsed.desired.kind === "custom") {
    const binding = parsed.desired.catalog.bindings[0];
    assert.ok(binding);
    assert.equal("apiKey" in binding, false);
    assert.equal("hopBaseUrl" in binding, false);
  }
  assert.equal(parsed.secret?.bytes, "sk-live");
});
