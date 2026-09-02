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
  const id = typeof item.id === "string" ? item.id.toLowerCase() : "";
  const name = typeof item.name === "string" ? item.name.toLowerCase() : "";
  return REASONING_ID_MARKERS.some((marker) => id.includes(marker) || name.includes(marker));
}

function normalizeCatalogEntry(item: unknown): CatalogModel | undefined {
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

function dedupeEntries(items: unknown[]): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const model = normalizeCatalogEntry(item);
    if (model === undefined || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

function normalizeSourceModels(source: CatalogSourceName, parsed: unknown): CatalogModel[] {
  if (source === "openrouter") {
    const data = isRecord(parsed) ? parsed.data : undefined;
    return Array.isArray(data) ? dedupeEntries(data) : [];
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
  return dedupeEntries(rows);
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
        for (const model of outcome.models) {
          lookup.set(model.id, model);
        }
        sources[i]!.modelCount = count;
        sources[i]!.lastFetched = stamp;
      } else {
        failures.push(outcome?.error ?? "fetch failed");
      }
    }
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
      const model = modelId !== undefined ? lookup.get(modelId) : undefined;
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
