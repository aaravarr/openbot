import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const botModels = require("../payload/bot-models.cjs") as {
  resolveAssignment(
    messages: unknown[],
    plan: unknown,
  ): { botId: string; modelId: string; stale: boolean } | undefined;
  writeBotModels(assignments: Record<string, string>): void;
};

const botId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const messages = [{ role: "system", content: "/home/box/agent-data/agents/" + botId + "/profile.json" }];
const plan = {
  kind: "custom",
  catalog: {
    providers: [],
    models: [{ id: "provider:special", providerId: "provider", slug: "special" }],
    bindings: [],
  },
};

function withAssignmentsFile<T>(run: (file: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-bot-models-"));
  const file = path.join(root, "assignments.json");
  const previous = process.env.OPENBOT_BOT_MODELS;
  process.env.OPENBOT_BOT_MODELS = file;
  try {
    return run(file);
  } finally {
    if (previous === undefined) delete process.env.OPENBOT_BOT_MODELS;
    else process.env.OPENBOT_BOT_MODELS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("bot model assignment resolves on every read and falls back when absent", () => {
  withAssignmentsFile(() => {
    assert.equal(botModels.resolveAssignment(messages, plan), undefined);
    botModels.writeBotModels({ [botId]: "provider:special" });
    assert.deepEqual(botModels.resolveAssignment(messages, plan), {
      botId,
      modelId: "provider:special",
      stale: false,
    });
    botModels.writeBotModels({});
    assert.equal(botModels.resolveAssignment(messages, plan), undefined);
  });
});

test("an assignment for a model removed from the catalog resolves as stale", () => {
  withAssignmentsFile(() => {
    botModels.writeBotModels({ [botId]: "provider:deleted" });
    assert.deepEqual(botModels.resolveAssignment(messages, plan), {
      botId,
      modelId: "provider:deleted",
      stale: true,
    });
  });
});

test("corrupt bot model assignments fail open", () => {
  withAssignmentsFile((file) => {
    fs.writeFileSync(file, "{not-json", "utf8");
    assert.equal(botModels.resolveAssignment(messages, plan), undefined);
  });
});
