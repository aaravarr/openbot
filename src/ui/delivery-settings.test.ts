import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isInjectionMode,
  parseInjectionLayers,
  readDeliverySettings,
  resolveInjectionPath,
  writeDeliverySettings,
} from "./delivery-settings.ts";

/** A sand-data stand-in on the real filesystem so the tests are OS-independent. */
function sandbox(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openbot-delivery-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function readFile(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("a missing config file reports the payload defaults", (t) => {
  const dir = sandbox(t);
  const state = readDeliverySettings(dir, {});
  assert.equal(state.mode, "off");
  assert.equal(state.source, "default");
  assert.equal(state.exists, false);
  assert.deepEqual(state.layers, { l1: false, l2: false, l3: false });
  assert.equal(state.maxAdditionalRuns, 1);
  assert.equal(state.envOverride, false);
  assert.equal(state.path, path.join(dir, "openbot-injection.json"));
});

test("an unparsable file reads as default and is replaced by a valid one on write", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "openbot-injection.json");
  writeFileSync(file, "{ not json");
  const before = readDeliverySettings(dir, {});
  assert.equal(before.exists, true);
  assert.equal(before.source, "default");
  assert.equal(before.mode, "off");
  const after = writeDeliverySettings(dir, { mode: "dry-run" }, {});
  assert.equal(after.mode, "dry-run");
  assert.equal(readFile(file).mode, "dry-run");
});

test("enabling the feature turns every layer on, so the switch is not inert", (t) => {
  const dir = sandbox(t);
  const state = writeDeliverySettings(dir, { mode: "enforce" }, {});
  assert.deepEqual(state.layers, { l1: true, l2: true, l3: true });
  assert.deepEqual(readFile(state.path), {
    mode: "enforce",
    layers: { l1: { enabled: true }, l2: { enabled: true }, l3: { enabled: true } },
  });
  assert.equal(state.source, "file");
  assert.equal(state.exists, true);
});

test("dry-run is written verbatim and keeps unrelated keys", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "openbot-injection.json");
  writeFileSync(file, JSON.stringify({ mode: "off", note: "hand written", layers: { l2: { timeoutMs: 9000 } } }));
  const state = writeDeliverySettings(dir, { mode: "dry-run" }, {});
  assert.equal(state.mode, "dry-run");
  const onDisk = readFile(file);
  assert.equal(onDisk.note, "hand written");
  assert.deepEqual(onDisk.layers, {
    l2: { timeoutMs: 9000, enabled: true },
    l1: { enabled: true },
    l3: { enabled: true },
  });
});

test("switching off keeps the layer blocks for the next enable", (t) => {
  const dir = sandbox(t);
  writeDeliverySettings(dir, { mode: "enforce" }, {});
  const off = writeDeliverySettings(dir, { mode: "off" }, {});
  assert.equal(off.mode, "off");
  const onDisk = readFile(off.path);
  assert.equal(onDisk.mode, "off");
  assert.deepEqual(onDisk.layers, { l1: { enabled: true }, l2: { enabled: true }, l3: { enabled: true } });
  assert.deepEqual(off.layers, { l1: true, l2: true, l3: true });
});

test("an explicit layer flag wins and omitted layers are left alone", (t) => {
  const dir = sandbox(t);
  writeDeliverySettings(dir, { mode: "enforce" }, {});
  const state = writeDeliverySettings(dir, { mode: "enforce", layers: { l2: false } }, {});
  assert.deepEqual(state.layers, { l1: true, l2: false, l3: true });
  const onDisk = readFile(state.path);
  assert.deepEqual(onDisk.layers, { l1: { enabled: true }, l2: { enabled: false }, l3: { enabled: true } });
});

test("a top-level layer block is edited in place and stays authoritative", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "openbot-injection.json");
  writeFileSync(file, JSON.stringify({ mode: "off", l1: { enabled: false, watchingSilenceThreshold: 4 } }));
  const state = writeDeliverySettings(dir, { mode: "enforce" }, {});
  const onDisk = readFile(file);
  assert.deepEqual(onDisk.l1, { enabled: true, watchingSilenceThreshold: 4 });
  // The file already used the top-level shape, so every layer must be written
  // there: a nested block would lose to the top-level one in the payload.
  assert.equal(onDisk.layers, undefined);
  assert.deepEqual(onDisk.l2, { enabled: true });
  assert.deepEqual(onDisk.l3, { enabled: true });
  assert.deepEqual(state.layers, { l1: true, l2: true, l3: true });
});

test("a present block without a boolean enabled flag counts as enabled, like the payload", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "openbot-injection.json");
  writeFileSync(file, JSON.stringify({ mode: "enforce", layers: { l1: { enabled: "yes" }, l2: { enabled: false } } }));
  const state = readDeliverySettings(dir, {});
  assert.deepEqual(state.layers, { l1: true, l2: false, l3: false });
});

test("maxAdditionalRuns is clamped to the payload range", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "openbot-injection.json");
  writeFileSync(file, JSON.stringify({ mode: "enforce", layers: { l2: { enabled: true, maxAdditionalRuns: 7 } } }));
  assert.equal(readDeliverySettings(dir, {}).maxAdditionalRuns, 1);
  writeFileSync(file, JSON.stringify({ mode: "enforce", layers: { l2: { enabled: true, maxAdditionalRuns: 0 } } }));
  assert.equal(readDeliverySettings(dir, {}).maxAdditionalRuns, 0);
});

test("the environment mode override pins the reported mode but still allows a write", (t) => {
  const dir = sandbox(t);
  const env = { OPENBOT_INJECTION_MODE: "enforce" };
  const before = readDeliverySettings(dir, env);
  assert.equal(before.mode, "enforce");
  assert.equal(before.source, "env");
  assert.equal(before.envOverride, true);
  const after = writeDeliverySettings(dir, { mode: "dry-run" }, env);
  assert.equal(after.mode, "enforce");
  assert.equal(readFile(after.path).mode, "dry-run");
  const invalid = readDeliverySettings(dir, { OPENBOT_INJECTION_MODE: "loud" });
  assert.equal(invalid.envOverride, false);
  assert.equal(invalid.mode, "dry-run");
});

test("the config path follows the payload precedence", (t) => {
  const dir = sandbox(t);
  assert.equal(resolveInjectionPath(dir, {}), path.join(dir, "openbot-injection.json"));
  assert.equal(
    resolveInjectionPath(dir, { OPENBOT_SAND_DATA: path.join(dir, "elsewhere") }),
    path.join(dir, "elsewhere", "openbot-injection.json"),
  );
  assert.equal(
    resolveInjectionPath(dir, { OPENBOT_PLAN: path.join(dir, "plan", "openbot-plan.json") }),
    path.join(dir, "plan", "openbot-injection.json"),
  );
  assert.equal(
    resolveInjectionPath(dir, { OPENBOT_INJECTION: path.join(dir, "custom.json"), OPENBOT_SAND_DATA: dir }),
    path.join(dir, "custom.json"),
  );
});

test("a write leaves no tmp file behind and creates a missing directory", (t) => {
  const dir = sandbox(t);
  const target = path.join(dir, "nested", "openbot-injection.json");
  const state = writeDeliverySettings(path.join(dir, "nested"), { mode: "dry-run" }, {});
  assert.equal(state.path, target);
  assert.equal(existsSync(target), true);
  assert.equal(existsSync(`${target}.tmp`), false);
});

test("layer parsing rejects non-boolean flags", () => {
  assert.deepEqual(parseInjectionLayers(undefined), { ok: true, layers: undefined });
  assert.deepEqual(parseInjectionLayers({ l1: true }), { ok: true, layers: { l1: true } });
  const bad = parseInjectionLayers({ l2: "yes" });
  assert.equal(bad.ok, false);
  assert.equal(parseInjectionLayers([]).ok, false);
  assert.equal(isInjectionMode("enforce"), true);
  assert.equal(isInjectionMode("on"), false);
});
