import fs from "node:fs";
import path from "node:path";

/**
 * Delivery follow-up ("injection hardening") settings.
 *
 * This module owns the read and write side of the sand-data config file that
 * `payload/injection-hardening.cjs` hot-reads on every hop request. Nothing here
 * talks to the hop directly: the UI writes the file and the next request picks
 * the change up, so a settings change never needs a restart or a host bounce.
 *
 * The normalisation rules below intentionally mirror `normalizeConfig` /
 * `readInjectionConfig` in that payload module. The payload stays the runtime
 * authority; this module only reports and edits the same file.
 */

export const INJECTION_FILE_NAME = "openbot-injection.json";
export const INJECTION_MODES = ["off", "dry-run", "enforce"] as const;
export type InjectionMode = (typeof INJECTION_MODES)[number];

export type InjectionLayerName = "l1" | "l2" | "l3";
export type InjectionLayers = Record<InjectionLayerName, boolean>;

export type DeliverySettings = {
  mode: InjectionMode;
  source: "env" | "file" | "default";
  path: string;
  exists: boolean;
  envOverride: boolean;
  layers: InjectionLayers;
  /** The payload hard-caps this at 1; a value outside 0..1 falls back to 1. */
  maxAdditionalRuns: number;
};

export type DeliveryWrite = {
  mode: InjectionMode;
  /** Omitted layers keep whatever the file already says; an absent `layers` field enables all three. */
  layers?: Partial<InjectionLayers> | undefined;
};

const LAYER_NAMES: readonly InjectionLayerName[] = ["l1", "l2", "l3"];
/** The per-layer override names `readInjectionConfig` in the payload honours. */
const LAYER_ENV_OVERRIDES: Record<InjectionLayerName, string> = {
  l1: "OPENBOT_INJECTION_L1_ENABLED",
  l2: "OPENBOT_INJECTION_L2_ENABLED",
  l3: "OPENBOT_INJECTION_L3_ENABLED",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isInjectionMode(value: unknown): value is InjectionMode {
  return typeof value === "string" && (INJECTION_MODES as readonly string[]).includes(value);
}

/**
 * Mirrors `injectionPath()` in the payload module, branch for branch. The payload
 * tests each var for truthiness without trimming, so a whitespace-only value names
 * that literal path on both sides and only an empty value falls through.
 */
export function resolveInjectionPath(sandData: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENBOT_INJECTION;
  if (explicit) return explicit;
  const envSandData = env.OPENBOT_SAND_DATA;
  if (envSandData) return path.join(envSandData, INJECTION_FILE_NAME);
  const plan = env.OPENBOT_PLAN;
  if (plan) return path.join(path.dirname(plan), INJECTION_FILE_NAME);
  return path.join(sandData, INJECTION_FILE_NAME);
}

function layerSource(raw: Record<string, unknown>, name: InjectionLayerName): Record<string, unknown> | undefined {
  const direct = raw[name];
  if (isRecord(direct)) return direct;
  const nested = raw.layers;
  if (isRecord(nested) && isRecord(nested[name])) return nested[name] as Record<string, unknown>;
  return undefined;
}

/** A present layer block enables the layer unless it explicitly says otherwise. */
function enabledOf(block: Record<string, unknown>): boolean {
  return typeof block.enabled === "boolean" ? block.enabled : true;
}

function maxAdditionalRunsOf(block: Record<string, unknown> | undefined): number {
  const n = Number(block?.maxAdditionalRuns);
  if (!Number.isInteger(n) || n < 0 || n > 1) return 1;
  return n;
}

function readRawObject(target: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The payload treats a top-level layer block as authoritative over `layers.<name>`. */
function usesNestedContainer(raw: Record<string, unknown> | undefined): boolean {
  if (!raw) return true;
  for (const name of LAYER_NAMES) {
    if (isRecord(raw[name])) return false;
  }
  return true;
}

function writeNestedLayer(next: Record<string, unknown>, name: InjectionLayerName, enabled: boolean): void {
  const layers = isRecord(next.layers) ? { ...next.layers } : {};
  const block = isRecord(layers[name]) ? (layers[name] as Record<string, unknown>) : {};
  layers[name] = { ...block, enabled };
  next.layers = layers;
}

function writeTopLevelLayer(next: Record<string, unknown>, name: InjectionLayerName, enabled: boolean): void {
  const block = isRecord(next[name]) ? (next[name] as Record<string, unknown>) : {};
  next[name] = { ...block, enabled };
}

/**
 * tmp+rename so a crash can never leave a truncated config behind. The temp
 * name is unique per writer (same convention as the pending-bounce write in
 * `src/supervisor/reconcile.ts`) so two concurrent writers cannot interleave:
 * with a fixed `.tmp` sibling, one rename can publish a file the other wrote
 * and the loser's rename fails ENOENT. The cleanup keeps a failed write from
 * straying, and never touches the target.
 */
function atomicWriteJson(target: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${String(process.pid)}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    fs.renameSync(tmp, target);
  } finally {
    // renameSync already consumed the temp on success; on failure, remove it.
    fs.rmSync(tmp, { force: true });
  }
}

/** Mirrors `envBool` in the payload: anything it does not recognise is ignored. */
function envBool(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(env, name)) return undefined;
  const value = String(env[name]).trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return undefined;
}

export function readDeliverySettings(sandData: string, env: NodeJS.ProcessEnv = process.env): DeliverySettings {
  const target = resolveInjectionPath(sandData, env);
  const raw = readRawObject(target);
  const layers: InjectionLayers = { l1: false, l2: false, l3: false };
  for (const name of LAYER_NAMES) {
    const block = raw ? layerSource(raw, name) : undefined;
    layers[name] = block ? enabledOf(block) : false;
    // The payload applies its per-layer overrides after the file is read and the
    // hop shares this process, so an override must win in the report too.
    const pinned = envBool(env, LAYER_ENV_OVERRIDES[name]);
    if (pinned !== undefined) layers[name] = pinned;
  }
  const rawMode = raw?.mode;
  let mode: InjectionMode = isInjectionMode(rawMode) ? rawMode : "off";
  const envMode = env.OPENBOT_INJECTION_MODE;
  const envOverride = isInjectionMode(envMode);
  if (envOverride) mode = envMode;
  return {
    mode,
    source: envOverride ? "env" : raw ? "file" : "default",
    path: target,
    exists: fs.existsSync(target),
    envOverride,
    layers,
    maxAdditionalRuns: maxAdditionalRunsOf(raw ? layerSource(raw, "l2") : undefined),
  };
}

export function writeDeliverySettings(
  sandData: string,
  input: DeliveryWrite,
  env: NodeJS.ProcessEnv = process.env,
): DeliverySettings {
  const target = resolveInjectionPath(sandData, env);
  const existing = readRawObject(target);
  const next: Record<string, unknown> = existing ? { ...existing } : {};
  if (input.mode === "off") {
    // The layer blocks stay put while the switch is off, so turning it back on
    // restores the previous tuning instead of silently resetting it.
    next.mode = "off";
  } else {
    next.mode = input.mode;
    const nested = usesNestedContainer(existing);
    for (const name of LAYER_NAMES) {
      const explicit = input.layers ? input.layers[name] : undefined;
      const enabled = explicit === undefined ? (input.layers ? undefined : true) : explicit;
      if (enabled === undefined) continue;
      if (nested) writeNestedLayer(next, name, enabled);
      else writeTopLevelLayer(next, name, enabled);
    }
  }
  atomicWriteJson(target, next);
  return readDeliverySettings(sandData, env);
}

export function parseInjectionLayers(
  value: unknown,
): { ok: true; layers: Partial<InjectionLayers> | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, layers: undefined };
  if (!isRecord(value)) return { ok: false, error: "layers must be an object" };
  const out: Partial<InjectionLayers> = {};
  for (const name of LAYER_NAMES) {
    const flag = value[name];
    if (flag === undefined) continue;
    if (typeof flag !== "boolean") return { ok: false, error: `layers.${name} must be a boolean` };
    out[name] = flag;
  }
  return { ok: true, layers: out };
}
