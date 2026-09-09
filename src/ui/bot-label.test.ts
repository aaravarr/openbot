import assert from "node:assert/strict";
import test from "node:test";
import { botDisplayName } from "../../web/src/lib/bot-label.ts";

test("legacy log without botId keeps its historical botName", () => {
  assert.equal(botDisplayName({ botName: "Legacy Bot" }, new Map()), "Legacy Bot");
});

test("renamed bot uses the current name resolved by botId", () => {
  assert.equal(botDisplayName({ botId: "bot-1", botName: "Old Name" }, new Map([["bot-1", "New Name"]])), "New Name");
});

test("deleted bot falls back to botId when the catalog no longer has it", () => {
  assert.equal(botDisplayName({ botId: "bot-1", botName: "Old Name" }, new Map()), "bot-1");
});
