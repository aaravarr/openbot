import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const runtimePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/runtime.cjs");

type Runtime = {
  wrapSession: (stockFn: (...args: unknown[]) => unknown, args: unknown) => unknown;
  attachSession: (stockFn: (...args: unknown[]) => unknown, args: unknown) => unknown;
  tapSession: (stockFn: (...args: unknown[]) => unknown, args: unknown) => unknown;
  isCustomMode: () => boolean;
  readPauseState: () => boolean;
  hopFullStream: (exec: unknown, agent: unknown, ctx: unknown, invocationId: string, tools: unknown[], options: unknown) => unknown;
  readPauseBotsState: () => string[];
};

function setup(mode: "official" | "custom"): { dir: string; runtime: Runtime } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-pause-"));
  writeFileSync(path.join(dir, "openbot-mode"), `${mode}\n`);
  writeFileSync(
    path.join(dir, "openbot-plan.json"),
    JSON.stringify({
      kind: "custom",
      agents: { "*": { modelId: "m", providerId: "p" } },
      catalog: { providers: [], models: [], bindings: [] },
    }),
  );
  process.env.OPENBOT_SAND_DATA = dir;
  process.env.OPENBOT_PLAN = path.join(dir, "openbot-plan.json");
  process.env.OPENBOT_MODE = path.join(dir, "openbot-mode");
  delete require.cache[runtimePath];
  return { dir, runtime: require(runtimePath) as Runtime };
}

function stockFn() {
  return {
    getSession() {
      return {
        getExecutor() {
          return { stream() {}, getMessages() { return []; } };
        },
        getModelId() {
          return "grok";
        },
      };
    },
    getProviderName() {
      return "proto";
    },
    getModelId() {
      return "grok";
    },
  };
}

test("readPauseState is false without a file and with a corrupt file", () => {
  const { dir, runtime } = setup("custom");
  assert.equal(runtime.readPauseState(), false);
  writeFileSync(path.join(dir, "openbot-pause.json"), "{not json");
  delete require.cache[runtimePath];
  const reloaded = require(runtimePath) as Runtime;
  assert.equal(reloaded.readPauseState(), false);
  rmSync(path.join(dir, "openbot-pause.json"));
  assert.equal(reloaded.readPauseState(), false);
});

test("custom wrapSession/attachSession throw gateway paused", () => {
  const { dir, runtime } = setup("custom");
  assert.equal(runtime.isCustomMode(), true);
  assert.doesNotThrow(() => runtime.wrapSession(stockFn, [{}]));
  assert.doesNotThrow(() => runtime.attachSession(stockFn, [{}]));
  writeFileSync(
    path.join(dir, "openbot-pause.json"),
    JSON.stringify({ paused: true, at: new Date().toISOString() }),
  );
  assert.throws(() => runtime.wrapSession(stockFn, [{}]), /gateway paused/);
  assert.throws(() => runtime.attachSession(stockFn, [{}]), /gateway paused/);
  rmSync(path.join(dir, "openbot-pause.json"));
  assert.doesNotThrow(() => runtime.wrapSession(stockFn, [{}]));
  assert.doesNotThrow(() => runtime.attachSession(stockFn, [{}]));
  writeFileSync(path.join(dir, "openbot-pause.json"), "{broken");
  assert.doesNotThrow(() => runtime.wrapSession(stockFn, [{}]));
});

test("official wrapSession entry is gated, tapSession stays a sync passthrough", () => {
  const { dir, runtime } = setup("official");
  assert.equal(runtime.isCustomMode(), false);
  assert.doesNotThrow(() => runtime.wrapSession(stockFn, [{}]));
  assert.doesNotThrow(() => runtime.tapSession(stockFn, [{}]));
  writeFileSync(
    path.join(dir, "openbot-pause.json"),
    JSON.stringify({ paused: true, at: new Date().toISOString(), note: "maintenance" }),
  );
  let out: unknown;
  try {
    runtime.wrapSession(stockFn, [{}]);
  } catch (err) {
    out = err;
  }
  assert.match((out as Error).message, /gateway paused/);
  assert.equal(out instanceof Promise, false);
  assert.throws(() => runtime.attachSession(stockFn, [{}]), /gateway paused/);
  assert.doesNotThrow(() => runtime.tapSession(stockFn, [{}]));
  rmSync(path.join(dir, "openbot-pause.json"));
  assert.doesNotThrow(() => runtime.wrapSession(stockFn, [{}]));
});

test("custom runtime stream throws a bot-specific pause error and fails open", async () => {
  const { dir, runtime } = setup("custom");
  const botId = "123e4567-e89b-12d3-a456-426614174000";
  const exec = {
    getMessages() {
      return [{ role: "system", content: "/home/box/agent-data/agents/" + botId + "/profile.json" }];
    },
  };
  writeFileSync(path.join(dir, "openbot-pause-bots.json"), JSON.stringify({ pausedBotIds: [botId] }));
  assert.deepEqual(runtime.readPauseBotsState(), [botId]);
  const stream = runtime.hopFullStream(exec, { modelId: "m", providerId: "p" }, {}, "test", [], {}) as { fullStream: AsyncIterable<unknown> };
  await assert.rejects(async () => {
    for await (const _part of stream.fullStream) {
      /* the paused bot must fail before any hop request */
    }
  }, /openbot-runtime: bot paused/);
  writeFileSync(path.join(dir, "openbot-pause-bots.json"), "{broken");
  assert.deepEqual(runtime.readPauseBotsState(), []);
  rmSync(dir, { recursive: true, force: true });
});
