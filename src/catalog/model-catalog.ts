import { type AbsPath } from "../domain/types.ts";
import { defaultFetch, filterModalities, type FetchLike } from "./provider-models.ts";

export type { FetchLike } from "./provider-models.ts";

/**
 * Source B: the merged cache of the public model catalogs (OpenRouter +
 * models.dev). Fetched asynchronously at process startup and on demand, merged
 * by model id, and persisted to disk so lookups never block on the network.
 */

export const MODEL_CATALOG_SOURCES = [
  { name: "openrouter", url: "https://openrouter.ai/api/v1/models" },
  { name: "models.dev", url: "https://models.dev/api.json" },
] as const;

export type CatalogSourceName = (typeof MODEL_CATALOG_SOURCES)[number]["name"];

export const MODEL_CATALOG_TIMEOUT_MS = 10_000;

export type CatalogPricing = {
  readonly input: number | null;
  readonly output: number | null;
  readonly currency: string;
};

export type CatalogModel = {
  readonly id: string;
  readonly name: string | null;
  readonly contextLength: number | null;
  readonly maxOutputTokens: number | null;
  readonly modalities: string[];
  readonly reasoning: boolean;
  readonly pricing: CatalogPricing | null;
};

export type CatalogSourceStatus = {
  readonly name: string;
  readonly url: string;
  readonly modelCount: number;
  readonly lastFetched: string | null;
};

export type CatalogLookup = { readonly found: true; readonly model: CatalogModel } | { readonly found: false };

export type CatalogSnapshot = {
  readonly status: "ready" | "loading" | "failed";
  readonly lastFetched: string | null;
  readonly totalModels: number;
  readonly sources: CatalogSourceStatus[];
  readonly error?: { readonly kind: string; readonly message: string };
  readonly lookup?: CatalogLookup;
};

export type CatalogCacheFs = {
  read(path: AbsPath): string | undefined;
  write(path: AbsPath, body: string): void;
};

export type CatalogManager = {
  /** Load the disk cache, then kick off a non-blocking re-fetch. */
  start(): Promise<void>;
  /** Trigger a re-fetch now (idempotent when one is already in flight). */
  refresh(): { readonly startedAt: string; readonly done: Promise<void> };
  /** Current status, plus a lookup when `modelId` is provided. */
  snapshot(modelId?: string): CatalogSnapshot;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return undefined;
}

function firstPositiveInt(...values: unknown[]): number | null {
  for (const value of values) {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(n) && n > 0) {
      return Math.floor(n);
    }
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const inner = value[key];
  return isRecord(inner) ? inner : undefined;
}

function firstPositiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return null;
}

function normalizePricing(value: unknown): CatalogPricing | null {
  const raw = isRecord(value) ? value : undefined;
  if (raw === undefined) {
    return null;
  }
  const input = firstPositiveNumber(raw.input, raw.prompt, raw.input_cost, raw.inputCost);
  const output = firstPositiveNumber(raw.output, raw.completion, raw.output_cost, raw.outputCost);
  if (input === null && output === null) {
    return null;
  }
  return {
    input,
    output,
    currency: typeof raw.currency === "string" && raw.currency.trim() ? raw.currency.trim().toUpperCase() : "USD",
  };
}

const REASONING_PARAMETERS = new Set(["reasoning", "reasoning_effort", "thinking", "thinking_effort"]);
const REASONING_ID_MARKERS = ["reasoner", "reasoning", "deepseek-r", ":thinking", "qwq", "-r1"];

function hasReasoning(item: Record<string, unknown>): boolean {
  const parameters = firstArray(item.supported_parameters, item.supportedParameters);
  if (parameters?.some((param) => typeof param === "string" && REASONING_PARAMETERS.has(param.toLowerCase()))) {
    return true;
  }
  // openrouter exposes a structured `reasoning` object (mandatory/default_enabled)
  // and models.dev exposes a bare boolean `reasoning`.
  const reasoningField = item.reasoning;
  if (reasoningField === true) {
    return true;
  }
  if (isRecord(reasoningField)) {
    if (reasoningField.mandatory === true || reasoningField.default_enabled === true || reasoningField.supported === true) {
      return true;
    }
    if (Array.isArray(reasoningField.supported_efforts) && reasoningField.supported_efforts.length > 0) {
      return true;
    }
  }
  const id = typeof item.id === "string" ? item.id.toLowerCase() : "";
  const name = typeof item.name === "string" ? item.name.toLowerCase() : "";
  return REASONING_ID_MARKERS.some((marker) => id.includes(marker) || name.includes(marker));
}

/** Strip the provider namespace, leaving the bare model id (`z-ai/glm-5.3-flash` -> `glm-5.3-flash`). */
function bareModelId(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

/** Count populated fields so alias resolution can prefer the richest record. */
function populatedFields(model: CatalogModel): number {
  let count = 0;
  if (model.name !== null) count += 1;
  if (model.contextLength !== null) count += 1;
  if (model.maxOutputTokens !== null) count += 1;
  if (model.modalities.length > 0) count += 1;
  if (model.reasoning) count += 1;
  if (model.pricing !== null) count += 1;
  return count;
}

function preferNonNull<T>(existing: T | null, incoming: T | null, incomingWins: boolean): T | null {
  if (existing !== null && incoming !== null) {
    return incomingWins ? incoming : existing;
  }
  return existing !== null ? existing : incoming;
}

function mergePricing(
  existing: CatalogPricing | null,
  incoming: CatalogPricing | null,
  incomingWins: boolean,
): CatalogPricing | null {
  if (existing === null) {
    return incoming;
  }
  if (incoming === null) {
    return existing;
  }
  const input = preferNonNull(existing.input, incoming.input, incomingWins);
  const output = preferNonNull(existing.output, incoming.output, incomingWins);
  if (input === null && output === null) {
    return null;
  }
  return {
    input,
    output,
    currency: incomingWins ? incoming.currency : existing.currency,
  };
}

/**
 * Field-level merge so a husk from one source never erases a populated field
 * from the other: a non-null (or non-empty) value wins over null/empty, and on
 * a true conflict the incoming record wins when it is the models.dev source.
 */
function mergeCatalogModel(existing: CatalogModel, incoming: CatalogModel, incomingWins: boolean): CatalogModel {
  const name = preferNonNull(existing.name, incoming.name, incomingWins);
  const contextLength = preferNonNull(existing.contextLength, incoming.contextLength, incomingWins);
  const maxOutputTokens = preferNonNull(existing.maxOutputTokens, incoming.maxOutputTokens, incomingWins);
  const modalities =
    preferNonNull(
      existing.modalities.length > 0 ? existing.modalities : null,
      incoming.modalities.length > 0 ? incoming.modalities : null,
      incomingWins,
    ) ?? [];
  return {
    id: existing.id,
    name,
    contextLength,
    maxOutputTokens,
    modalities,
    reasoning: existing.reasoning || incoming.reasoning,
    pricing: mergePricing(existing.pricing, incoming.pricing, incomingWins),
  };
}

/**
 * openrouter `/api/v1/models` entry: a flat object with `context_length`,
 * `top_provider.max_completion_tokens`, `architecture.input_modalities`,
 * `supported_parameters` and `pricing`.
 */
function normalizeOpenRouterEntry(item: unknown): CatalogModel | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  if (typeof item.id !== "string" || !item.id.trim()) {
    return undefined;
  }
  const architecture = nestedRecord(item, "architecture");
  const topProvider = nestedRecord(item, "top_provider");
  return {
    id: item.id.trim(),
    name: stringOrNull(item.name),
    contextLength: firstPositiveInt(item.context_length, item.contextLength, architecture?.context_length),
    maxOutputTokens: firstPositiveInt(
      topProvider?.max_completion_tokens,
      item.max_completion_tokens,
      item.maxOutputTokens,
    ),
    modalities: filterModalities(firstArray(item.input_modalities, architecture?.input_modalities, item.modalities)),
    reasoning: hasReasoning(item),
    pricing: normalizePricing(item.pricing),
  };
}

/**
 * models.dev `/api.json` entry: nested under `<provider>.models.<modelId>` with
 * `limit: { context, output }`, `modalities: { input, output }`, `reasoning`
 * (boolean) and `cost: { input, output }`. The entry's own `id` equals the model
 * key, so it is read directly.
 */
function normalizeModelsDevEntry(item: unknown): CatalogModel | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  if (typeof item.id !== "string" || !item.id.trim()) {
    return undefined;
  }
  const limit = nestedRecord(item, "limit");
  const modalities = nestedRecord(item, "modalities");
  return {
    id: item.id.trim(),
    name: stringOrNull(item.name),
    contextLength: firstPositiveInt(limit?.context, item.context_length, item.contextLength),
    maxOutputTokens: firstPositiveInt(limit?.output, item.max_output_tokens, item.maxOutputTokens),
    modalities: filterModalities(firstArray(modalities?.input, item.input_modalities, item.modalities)),
    reasoning: item.reasoning === true || hasReasoning(item),
    pricing: normalizePricing(item.cost ?? item.pricing),
  };
}

function dedupeEntries(
  items: unknown[],
  normalize: (item: unknown) => CatalogModel | undefined,
): CatalogModel[] {
  const out: CatalogModel[] = [];
  const index = new Map<string, number>();
  for (const item of items) {
    const model = normalize(item);
    if (model === undefined) {
      continue;
    }
    const existing = index.get(model.id);
    if (existing === undefined) {
      index.set(model.id, out.length);
      out.push(model);
    } else {
      out[existing] = mergeCatalogModel(out[existing]!, model, false);
    }
  }
  return out;
}

function normalizeSourceModels(source: CatalogSourceName, parsed: unknown): CatalogModel[] {
  if (source === "openrouter") {
    const data = isRecord(parsed) ? parsed.data : undefined;
    return Array.isArray(data) ? dedupeEntries(data, normalizeOpenRouterEntry) : [];
  }
  // models.dev/api.json is an object keyed by provider id.
  if (!isRecord(parsed)) {
    return [];
  }
  const rows: unknown[] = [];
  for (const provider of Object.values(parsed)) {
    const models = isRecord(provider) ? provider.models : undefined;
    if (isRecord(models)) {
      rows.push(...Object.values(models));
    }
  }
  return dedupeEntries(rows, normalizeModelsDevEntry);
}

function parseCatalogModel(value: unknown): CatalogModel | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.id !== "string" || !value.id.trim()) {
    return undefined;
  }
  const modalities = Array.isArray(value.modalities)
    ? value.modalities.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
  return {
    id: value.id.trim(),
    name: typeof value.name === "string" ? value.name : null,
    contextLength: firstPositiveInt(value.contextLength),
    maxOutputTokens: firstPositiveInt(value.maxOutputTokens),
    modalities,
    reasoning: value.reasoning === true,
    pricing: normalizePricing(value.pricing),
  };
}

type FetchOutcome = { readonly ok: true; readonly models: CatalogModel[] } | { readonly ok: false; readonly error: string };

async function fetchSource(source: { readonly name: CatalogSourceName; readonly url: string }, fetchFn: FetchLike): Promise<FetchOutcome> {
  let res: { readonly status: number; readonly ok: boolean; text(): Promise<string> };
  try {
    res = await fetchFn(source.url, { signal: AbortSignal.timeout(MODEL_CATALOG_TIMEOUT_MS) });
  } catch {
    return { ok: false, error: `${source.name} is unreachable` };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: `${source.name} returned HTTP ${res.status}` };
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ok: false, error: `${source.name} response could not be read` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `${source.name} returned a non-JSON body` };
  }
  return { ok: true, models: normalizeSourceModels(source.name, parsed) };
}

export function createCatalogManager(deps: {
  fs: CatalogCacheFs;
  cachePath: AbsPath;
  fetchFn?: FetchLike;
  now?: () => string;
}): CatalogManager {
  const fetchFn = deps.fetchFn ?? defaultFetch;
  const now = deps.now ?? (() => new Date().toISOString());

  let hasData = false;
  let lastFetched: string | null = null;
  let lastError: { readonly kind: string; readonly message: string } | null = null;
  let startedAt: string | null = null;
  let activeFetch: Promise<void> | null = null;

  const lookup = new Map<string, CatalogModel>();
  const sources: { name: string; url: string; modelCount: number; lastFetched: string | null }[] =
    MODEL_CATALOG_SOURCES.map((source) => ({ name: source.name, url: source.url, modelCount: 0, lastFetched: null }));

  // Derived alias index: bare model id -> richest catalog record, so lookups by
  // either the namespaced id (`z-ai/glm-5.3-flash`) or the bare id
  // (`glm-5.3-flash`) both resolve. Rebuilt from `lookup` after every load/fetch.
  let bareIndex = new Map<string, CatalogModel>();

  function rebuildBareIndex(): void {
    const next = new Map<string, CatalogModel>();
    for (const model of lookup.values()) {
      const bare = bareModelId(model.id);
      const current = next.get(bare);
      if (
        current === undefined ||
        populatedFields(model) > populatedFields(current) ||
        (populatedFields(model) === populatedFields(current) && model.id < current.id)
      ) {
        next.set(bare, model);
      }
    }
    bareIndex = next;
  }

  function currentStatus(): "ready" | "loading" | "failed" {
    if (activeFetch !== null) {
      return "loading";
    }
    if (hasData) {
      return "ready";
    }
    if (lastError !== null) {
      return "failed";
    }
    return "loading";
  }

  function persist(): void {
    const models: { [id: string]: CatalogModel } = {};
    for (const [id, model] of lookup) {
      models[id] = model;
    }
    deps.fs.write(
      deps.cachePath,
      `${JSON.stringify({ lastFetched, totalModels: lookup.size, sources, models }, null, 2)}\n`,
    );
  }

  function loadFromDisk(): boolean {
    const raw = deps.fs.read(deps.cachePath);
    if (raw === undefined) {
      return false;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return false;
      }
      if (isRecord(parsed.models)) {
        for (const [id, entry] of Object.entries(parsed.models)) {
          const model = parseCatalogModel(entry);
          if (model !== undefined && model.id === id) {
            lookup.set(id, model);
          }
        }
      }
      if (typeof parsed.lastFetched === "string") {
        lastFetched = parsed.lastFetched;
      }
      if (Array.isArray(parsed.sources)) {
        for (const source of sources) {
          const match = parsed.sources.find((row) => isRecord(row) && row.name === source.name);
          if (match !== undefined) {
            source.modelCount = firstPositiveInt(match.modelCount) ?? 0;
            source.lastFetched = typeof match.lastFetched === "string" ? match.lastFetched : null;
          }
        }
      }
      rebuildBareIndex();
      hasData = true;
      return true;
    } catch {
      return false;
    }
  }

  async function doFetch(): Promise<void> {
    const stamp = now();
    startedAt = stamp;
    const outcomes = await Promise.all(MODEL_CATALOG_SOURCES.map((source) => fetchSource(source, fetchFn)));
    let anySuccess = false;
    const failures: string[] = [];
    for (let i = 0; i < MODEL_CATALOG_SOURCES.length; i++) {
      const outcome = outcomes[i];
      if (outcome !== undefined && outcome.ok) {
        anySuccess = true;
        const count = outcome.models.length;
        const incomingWins = MODEL_CATALOG_SOURCES[i]!.name === "models.dev";
        for (const model of outcome.models) {
          const existing = lookup.get(model.id);
          lookup.set(model.id, existing === undefined ? model : mergeCatalogModel(existing, model, incomingWins));
        }
        sources[i]!.modelCount = count;
        sources[i]!.lastFetched = stamp;
      } else {
        failures.push(outcome?.error ?? "fetch failed");
      }
    }
    rebuildBareIndex();
    if (anySuccess) {
      lastFetched = stamp;
      lastError = null;
      hasData = true;
      try {
        persist();
      } catch {
        /* the in-memory cache is authoritative; a failed write must not fail the fetch */
      }
    } else if (!hasData) {
      lastError = { kind: "unreachable", message: failures[0] ?? "model catalog fetch failed" };
    }
  }

  function runFetch(): Promise<void> {
    if (activeFetch !== null) {
      return activeFetch;
    }
    const running = doFetch().finally(() => {
      activeFetch = null;
    });
    activeFetch = running;
    return running;
  }

  return {
    start() {
      loadFromDisk();
      return runFetch();
    },
    refresh() {
      const done = runFetch();
      return { startedAt: startedAt ?? now(), done };
    },
    snapshot(modelId?: string): CatalogSnapshot {
      const status = currentStatus();
      const model = modelId !== undefined ? (lookup.get(modelId) ?? bareIndex.get(bareModelId(modelId))) : undefined;
      const lookupValue: CatalogLookup | undefined =
        modelId !== undefined ? (model !== undefined ? { found: true, model } : { found: false }) : undefined;
      return {
        status,
        lastFetched,
        totalModels: lookup.size,
        sources: sources.map((source) => ({
          name: source.name,
          url: source.url,
          modelCount: source.modelCount,
          lastFetched: source.lastFetched,
        })),
        ...(status === "failed" && lastError !== null ? { error: lastError } : {}),
        ...(lookupValue !== undefined ? { lookup: lookupValue } : {}),
      };
    },
  };
}
