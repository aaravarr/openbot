import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { readDeliverySettings, resolveInjectionPath, writeDeliverySettings } from "./delivery-settings.ts";

/**
 * The payload module is the runtime authority for the sand-data file the
 * Settings page edits: the hop hot-reads it on every request, and
 * `src/ui/delivery-settings.ts` only mirrors its rules. These tests therefore
 * use the real payload (required, never re-implemented) as the oracle for what
 * a UI write actually arms.
 */

type PayloadLayer = { enabled?: boolean; maxAdditionalRuns?: number };
type PayloadConfig = { mode: string; l1?: PayloadLayer; l2?: PayloadLayer; l3?: PayloadLayer };
type PayloadInjection =
  | { family?: string; injectionWouldApply?: boolean; injectionApplied?: boolean }
  | undefined;

type PayloadModule = {
  DEFAULT_CONFIG: { mode: string; l1: PayloadLayer; l2: PayloadLayer; l3: PayloadLayer };
  REPLY_FIRST_REMINDER: string;
  injectionPath: () => string;
  readInjectionConfig: () => PayloadConfig;
  applyPreGeneration: (
    messages: unknown[],
    options?: Record<string, unknown>,
  ) => { messages: unknown[]; injection: PayloadInjection; config: { mode: string } };
  resetForTests: () => void;
};

const payload = createRequire(import.meta.url)("../../payload/injection-hardening.cjs") as PayloadModule;

const INJECTION_FILE = "openbot-injection.json";
const BOX_SAND_DATA = "/home/box/sand-data";
/** The payload fallback when no OPENBOT_* path env is set (injection-hardening.cjs line 84). */
const BOX_INJECTION_PATH = "/home/box/sand-data/openbot-injection.json";

/** Every env var either side reads while resolving or overriding the config. */
const MANAGED_ENV = [
  "OPENBOT_INJECTION",
  "OPENBOT_SAND_DATA",
  "OPENBOT_PLAN",
  "OPENBOT_INJECTION_MODE",
  "OPENBOT_INJECTION_L1_ENABLED",
  "OPENBOT_INJECTION_L2_ENABLED",
  "OPENBOT_INJECTION_L3_ENABLED",
] as const;
type ManagedEnv = (typeof MANAGED_ENV)[number];

const START_ENV = MANAGED_ENV.map((name) => [name, process.env[name]] as const);

/** Proves this file put every managed var back; the payload reads process.env directly. */
after(() => {
  for (const [name, value] of START_ENV) {
    assert.equal(process.env[name], value, name + " leaked out of this test file");
  }
});

function sandbox(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openbot-delivery-payload-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Replaces every managed env var; the returned restore must run in a finally. */
function setManagedEnv(values: Partial<Record<ManagedEnv, string>>): () => void {
  const saved = MANAGED_ENV.map((name) => [name, process.env[name]] as const);
  for (const name of MANAGED_ENV) {
    const next = values[name];
    if (next === undefined) delete process.env[name];
    else process.env[name] = next;
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** Points the payload at `dir` for one call and never leaves env state behind. */
function withPayloadAt<T>(dir: string, fn: () => T): T {
  const restore = setManagedEnv({ OPENBOT_SAND_DATA: dir });
  try {
    assert.equal(payload.injectionPath(), path.join(dir, INJECTION_FILE), "the payload must read the sandbox file");
    return fn();
  } finally {
    restore();
  }
}

function readFile(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function layerFlags(config: PayloadConfig): boolean[] {
  return [config.l1?.enabled, config.l2?.enabled, config.l3?.enabled].map((value) => value === true);
}

/** A person-opened 1:1 context, the cheapest shape the payload identity gate accepts. */
function directChat(conversationId: string): Record<string, unknown> {
  return { observed: { botId: "bot-1", conversationId: conversationId, epochId: "epoch-1", directChat: true } };
}

test("claim 1: a dry-run write reaches the payload with all three layers enabled", (t) => {
  const dir = sandbox(t);
  writeDeliverySettings(dir, { mode: "dry-run" }, {});
  const config = withPayloadAt(dir, () => payload.readInjectionConfig());
  assert.equal(config.mode, "dry-run");
  assert.deepEqual(layerFlags(config), [true, true, true]);
});

test("claim 2: an enforce write satisfies both halves of the payload L2 gate", (t) => {
  const dir = sandbox(t);
  writeDeliverySettings(dir, { mode: "enforce" }, {});
  const config = withPayloadAt(dir, () => payload.readInjectionConfig());
  assert.equal(config.mode, "enforce");
  // The bail-out at injection-hardening.cjs line 904 reads exactly this pair.
  assert.equal(config.mode === "enforce" && config.l2?.enabled === true, true);
  assert.equal(config.l3?.enabled, true);
  assert.equal(config.l1?.enabled, true);
});

test("claim 3: an off write returns exactly { mode: \"off\" } and leaves the layer blocks inert", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, INJECTION_FILE);
  writeDeliverySettings(dir, { mode: "enforce" }, {});
  assert.ok(readFile(file).layers, "enforce must create the layer blocks first");
  const off = writeDeliverySettings(dir, { mode: "off" }, {});
  assert.equal(off.mode, "off");
  assert.deepEqual(
    readFile(file).layers,
    { l1: { enabled: true }, l2: { enabled: true }, l3: { enabled: true } },
    "the off write must leave the layer blocks on disk",
  );
  const config = withPayloadAt(dir, () => payload.readInjectionConfig());
  assert.deepEqual(config, { mode: "off" });
  assert.equal(Object.keys(config).length, 1);
  assert.equal(config.l2, undefined);
  // The UI still reports the preserved layer flags while the switch is off, while
  // the payload drops them entirely. That difference is cosmetic: the mode gate
  // leaves both inert, which the pre-generation test below proves directly.
  assert.deepEqual(readDeliverySettings(dir, {}).layers, { l1: true, l2: true, l3: true });
});

test("claim 4: a bare hand-written mode file disables every layer, the UI write does not", (t) => {
  const bare = sandbox(t);
  writeFileSync(path.join(bare, INJECTION_FILE), JSON.stringify({ mode: "enforce" }));
  const bareConfig = withPayloadAt(bare, () => payload.readInjectionConfig());
  assert.equal(bareConfig.mode, "enforce");
  assert.deepEqual(layerFlags(bareConfig), [false, false, false], "a layer runs only while its object is present");
  assert.deepEqual(
    [payload.DEFAULT_CONFIG.l1.enabled, payload.DEFAULT_CONFIG.l2.enabled, payload.DEFAULT_CONFIG.l3.enabled],
    [false, false, false],
    "the payload defaults agree: a missing layer object means disabled",
  );

  const written = sandbox(t);
  writeDeliverySettings(written, { mode: "enforce" }, {});
  assert.ok(readFile(path.join(written, INJECTION_FILE)).layers, "the UI write creates the layer objects");
  const writtenConfig = withPayloadAt(written, () => payload.readInjectionConfig());
  assert.equal(writtenConfig.mode, "enforce");
  assert.deepEqual(layerFlags(writtenConfig), [true, true, true]);
});

test("claim 5: the config path follows the payload precedence, branch for branch", (t) => {
  const dir = sandbox(t);
  const elsewhere = path.join(dir, "elsewhere");
  const plan = path.join(dir, "plan", "openbot-plan.json");
  const custom = path.join(dir, "custom.json");
  const cases: { name: string; env: Partial<Record<ManagedEnv, string>>; sandData: string }[] = [
    {
      name: "OPENBOT_INJECTION beats OPENBOT_SAND_DATA and OPENBOT_PLAN",
      env: { OPENBOT_INJECTION: custom, OPENBOT_SAND_DATA: elsewhere, OPENBOT_PLAN: plan },
      sandData: dir,
    },
    { name: "OPENBOT_SAND_DATA beats the sandData argument", env: { OPENBOT_SAND_DATA: elsewhere }, sandData: dir },
    { name: "only OPENBOT_PLAN", env: { OPENBOT_PLAN: plan }, sandData: dir },
  ];
  for (const item of cases) {
    const restore = setManagedEnv(item.env);
    try {
      assert.equal(resolveInjectionPath(item.sandData, process.env), payload.injectionPath(), item.name);
    } finally {
      restore();
    }
  }

  // The "none set" branch cannot agree by construction: the payload falls back to
  // a hardcoded box path while the UI joins the sandData it is handed, so the two
  // only name the same file when the caller passes the box path itself.
  const restore = setManagedEnv({});
  try {
    assert.equal(payload.injectionPath(), BOX_INJECTION_PATH);
    assert.equal(resolveInjectionPath(BOX_SAND_DATA, {}), path.join(BOX_SAND_DATA, INJECTION_FILE));
    assert.equal(
      resolveInjectionPath(BOX_SAND_DATA, {}).split(path.sep).join("/"),
      BOX_INJECTION_PATH,
      "same file once the platform separator is normalized",
    );
    if (path.sep === "/") {
      assert.equal(resolveInjectionPath(BOX_SAND_DATA, {}), payload.injectionPath(), "byte-identical on POSIX");
    }
    assert.notEqual(
      resolveInjectionPath(dir, {}),
      payload.injectionPath(),
      "any other sandData writes a file the hop never reads",
    );
  } finally {
    restore();
  }
});

test("the write drives the payload pre-generation decision, not only its config parse", (t) => {
  const dir = sandbox(t);
  payload.resetForTests();

  // dry-run: the payload records would-apply and must not touch the messages.
  writeDeliverySettings(dir, { mode: "dry-run" }, {});
  const dry = withPayloadAt(dir, () =>
    payload.applyPreGeneration([{ role: "user", content: "hello" }], {
      context: directChat("dry-run-conversation"),
      opening: true,
    }),
  );
  assert.equal(dry.injection?.injectionWouldApply, true);
  assert.equal(dry.injection?.family, "l1.reply-first");
  assert.notEqual(dry.injection?.injectionApplied, true, "dry-run must not apply the injection");
  assert.deepEqual(dry.messages, [{ role: "user", content: "hello" }]);

  // enforce: the payload appends its own reminder body to the opening message.
  writeDeliverySettings(dir, { mode: "enforce" }, {});
  const enforced = withPayloadAt(dir, () =>
    payload.applyPreGeneration([{ role: "user", content: "hello" }], {
      context: directChat("enforce-conversation"),
      opening: true,
    }),
  );
  assert.equal(enforced.injection?.injectionApplied, true);
  assert.equal(enforced.messages.length, 1);
  const first = enforced.messages[0] as { content?: unknown };
  assert.equal(first.content, "hello" + payload.REPLY_FIRST_REMINDER);

  // off: the payload returns before any injection decision.
  writeDeliverySettings(dir, { mode: "off" }, {});
  const off = withPayloadAt(dir, () =>
    payload.applyPreGeneration([{ role: "user", content: "hello" }], {
      context: directChat("off-conversation"),
      opening: true,
    }),
  );
  assert.equal(off.config.mode, "off");
  assert.equal(off.injection, undefined);
  assert.deepEqual(off.messages, [{ role: "user", content: "hello" }]);
});

/**
 * ENV AGREEMENT, pinned on purpose so it fails loudly if either side moves: the
 * payload reads process.env at call time, and the UI mirrors the same vars, so
 * every case below asserts the two sides agree — on the resolved path, on the
 * per-layer overrides, and on the traps that remain (the mode override and the
 * mode-only write). The first two were divergences until the mirror was fixed.
 */
test("shared env: the UI report agrees with the payload on paths and layer overrides", (t) => {
  const dir = sandbox(t);
  writeDeliverySettings(dir, { mode: "enforce" }, {});

  // 1. A whitespace-only OPENBOT_INJECTION is truthy and untrimmed on both sides,
  //    so the UI now names the same literal path the payload reads.
  const restorePath = setManagedEnv({ OPENBOT_INJECTION: "   ", OPENBOT_SAND_DATA: dir });
  try {
    assert.equal(payload.injectionPath(), "   ");
    assert.equal(resolveInjectionPath(dir, process.env), "   ");
    assert.equal(resolveInjectionPath(dir, process.env), payload.injectionPath());
    // Both sides read that literal (missing) file, so both report inert layers.
    assert.deepEqual(layerFlags(payload.readInjectionConfig()), [false, false, false]);
    assert.deepEqual(readDeliverySettings(dir, process.env).layers, { l1: false, l2: false, l3: false });
  } finally {
    restorePath();
  }

  // 2. A per-layer override disarms the hop, and the UI reads the same shared
  //    process.env, so it must report the layer the hop will actually run.
  const restoreL2 = setManagedEnv({ OPENBOT_SAND_DATA: dir, OPENBOT_INJECTION_L2_ENABLED: "false" });
  try {
    const config = payload.readInjectionConfig();
    assert.equal(config.mode, "enforce");
    assert.equal(config.l2?.enabled, false);
    assert.equal(config.l3?.enabled, true);
    assert.deepEqual(layerFlags(config), [true, false, true]);
    assert.deepEqual(readDeliverySettings(dir, process.env).layers, { l1: true, l2: false, l3: true });
  } finally {
    restoreL2();
  }

  // All three overrides at once, in the disarming direction: the file still arms
  // every layer while both sides report none of them armed.
  const restoreLayers = setManagedEnv({
    OPENBOT_SAND_DATA: dir,
    OPENBOT_INJECTION_L1_ENABLED: "0",
    OPENBOT_INJECTION_L2_ENABLED: "no",
    OPENBOT_INJECTION_L3_ENABLED: " OFF ",
  });
  try {
    assert.deepEqual(layerFlags(payload.readInjectionConfig()), [false, false, false]);
    assert.deepEqual(readDeliverySettings(dir, process.env).layers, { l1: false, l2: false, l3: false });
  } finally {
    restoreLayers();
  }

  // 3. OPENBOT_INJECTION_MODE outranks the file, so a write can be inert; here the
  //    UI does surface it (source: env, envOverride: true) instead of lying.
  const restoreMode = setManagedEnv({ OPENBOT_SAND_DATA: dir, OPENBOT_INJECTION_MODE: "off" });
  try {
    assert.deepEqual(payload.readInjectionConfig(), { mode: "off" });
    const reported = readDeliverySettings(dir, process.env);
    assert.equal(reported.mode, "off");
    assert.equal(reported.envOverride, true);
  } finally {
    restoreMode();
  }

  // 4. A file that already says l2.enabled=false is silently re-armed by a plain
  //    non-off write, because the page sends only a mode.
  writeFileSync(
    path.join(dir, INJECTION_FILE),
    JSON.stringify({ mode: "enforce", layers: { l1: { enabled: true }, l2: { enabled: false }, l3: { enabled: true } } }),
  );
  assert.deepEqual(readDeliverySettings(dir, {}).layers, { l1: true, l2: false, l3: true });
  writeDeliverySettings(dir, { mode: "enforce" }, {});
  const rearmed = withPayloadAt(dir, () => payload.readInjectionConfig());
  assert.deepEqual(layerFlags(rearmed), [true, true, true], "a mode-only write re-arms every layer");
});
