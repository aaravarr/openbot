import { type Catalog } from "../domain/types.ts";
import { keepReasoningOrder } from "../domain/model.ts";
import { secretFor, type SecretStore } from "../supervisor/secrets.ts";
import { fetchedReasoningLevels, mapVendorEffort } from "./reasoning-efforts.ts";

/**
 * Source A: fetch a provider's own model list from its base URL + /v1/models,
 * server-side, using the stored secret. Secrets never leave the process and are
 * never echoed back or logged.
 */

/** Minimal fetch surface so tests can mock the outbound network. */
export type FetchLike = (
  url: string,
  init?: { readonly headers?: Record<string, string>; readonly signal?: AbortSignal },
) => Promise<{ readonly status: number; readonly ok: boolean; text(): Promise<string> }>;

export const PROVIDER_MODELS_TOTAL_TIMEOUT_MS = 30_000;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

const MODALITY_TOKENS = new Set<string>(["text", "image", "video", "audio"]);

/** Normalized Source A model row (PRD §8.1 models[]). */
export type FetchedModel = {
  readonly id: string;
  readonly name: string | null;
  readonly contextLength: number | null;
  readonly maxOutputTokens: number | null;
  readonly modalities: string[];
  readonly reasoningLevels: string[];
};

export type FetchErrorKind = "unauthorized" | "unreachable" | "not-supported" | "parse-error" | "internal";

export type FetchProviderResult =
  | { readonly ok: true; readonly models: FetchedModel[]; readonly skipped: number; readonly skippedReasons: string[] }
  | { readonly ok: false; readonly errorKind: FetchErrorKind; readonly message: string; readonly upstreamStatus?: number };

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

export function filterModalities(value: unknown): string[] {
  const raw = firstArray(value);
  const out: string[] = [];
  const seen = new Set<string>();
  if (raw) {
    for (const item of raw) {
      if (typeof item !== "string") {
        continue;
      }
      const token = item.trim().toLowerCase();
      if (MODALITY_TOKENS.has(token) && !seen.has(token)) {
        seen.add(token);
        out.push(token);
      }
    }
  }
  return out;
}

export function filterReasoningLevels(value: unknown): string[] {
  const raw = firstArray(value);
  const seen = new Set<string>();
  if (raw) {
    for (const item of raw) {
      const mapped = mapVendorEffort(item);
      if (mapped !== undefined) {
        seen.add(mapped);
      }
    }
  }
  return keepReasoningOrder(seen);
}

function modelListFrom(raw: unknown): unknown[] | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (Array.isArray(raw.data)) {
    return raw.data;
  }
  if (Array.isArray(raw.models)) {
    return raw.models;
  }
  return undefined;
}

function normalizeEntry(item: Record<string, unknown>, id: string): FetchedModel {
  const architecture = nestedRecord(item, "architecture");
  const topProvider = nestedRecord(item, "top_provider");
  return {
    id,
    name: stringOrNull(item.name),
    contextLength: firstPositiveInt(item.context_length, item.contextLength, architecture?.context_length),
    maxOutputTokens: firstPositiveInt(
      topProvider?.max_completion_tokens,
      item.max_completion_tokens,
      item.maxOutputTokens,
      item.max_tokens,
    ),
    modalities: filterModalities(firstArray(item.input_modalities, architecture?.input_modalities, item.modalities)),
    reasoningLevels: [...fetchedReasoningLevels(item)],
  };
}

/**
 * Normalize a provider `/v1/models` response body (`{ data: [...] }` or
 * `{ models: [...] }`). Returns `undefined` when the body is not a model list.
 */
export function normalizeProviderModels(
  raw: unknown,
): { models: FetchedModel[]; skipped: number; skippedReasons: string[] } | undefined {
  const list = modelListFrom(raw);
  if (list === undefined) {
    return undefined;
  }
  const models: FetchedModel[] = [];
  const skippedReasons: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isRecord(item)) {
      skippedReasons.push("not-an-object");
      continue;
    }
    if (typeof item.id !== "string" || !item.id.trim()) {
      skippedReasons.push("missing-id");
      continue;
    }
    const id = item.id.trim();
    if (seen.has(id)) {
      skippedReasons.push("duplicate-id");
      continue;
    }
    seen.add(id);
    models.push(normalizeEntry(item, id));
  }
  return { models, skipped: skippedReasons.length, skippedReasons };
}

/** The provider's `/v1/models` URL, reusing the hop's base-URL normalization. */
export function modelsUrl(origin: string): string {
  const base = origin.replace(/\/+$/, "");
  if (!base) {
    throw new Error("openbot: provider origin is empty");
  }
  if (
    /\/v1$/i.test(base) ||
    /\/v4$/i.test(base) ||
    /\/paas\/v4$/i.test(base) ||
    /\/chat\/completions$/i.test(base)
  ) {
    return `${base}/models`;
  }
  return `${base}/v1/models`;
}

function timeoutMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return "provider timed out";
  }
  return "provider is unreachable";
}

async function fetchProviderModels(input: {
  url: string;
  secret: string;
  fetchFn: FetchLike;
  totalTimeoutMs: number;
}): Promise<FetchProviderResult> {
  let res: { readonly status: number; readonly ok: boolean; text(): Promise<string> };
  try {
    res = await input.fetchFn(input.url, {
      headers: { Authorization: `Bearer ${input.secret}`, Accept: "application/json" },
      signal: AbortSignal.timeout(input.totalTimeoutMs),
    });
  } catch (err) {
    return { ok: false, errorKind: "unreachable", message: timeoutMessage(err) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, errorKind: "unauthorized", message: "provider rejected the API key", upstreamStatus: res.status };
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return {
      ok: false,
      errorKind: "not-supported",
      message: "provider does not expose a model list",
      upstreamStatus: res.status,
    };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, errorKind: "unreachable", message: `upstream returned HTTP ${res.status}`, upstreamStatus: res.status };
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ok: false, errorKind: "unreachable", message: "failed to read the upstream response" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errorKind: "parse-error", message: "provider returned a non-JSON body" };
  }
  const normalized = normalizeProviderModels(parsed);
  if (normalized === undefined) {
    return { ok: false, errorKind: "parse-error", message: "provider response is not a model list" };
  }
  return { ok: true, ...normalized };
}

function httpStatusFor(kind: FetchErrorKind): number {
  switch (kind) {
    case "unauthorized":
      return 401;
    case "not-supported":
    case "unreachable":
    case "parse-error":
      return 502;
    case "internal":
      return 500;
  }
}

/**
 * Endpoint logic for `POST /api/providers/{providerId}/fetch-models`. Resolves
 * the provider, requires a stored secret, fetches and normalizes the model list,
 * and returns the HTTP status + JSON body for the caller to send.
 */
export async function fetchModelsForProvider(input: {
  providerId: string;
  catalog: Catalog;
  secretStore: SecretStore;
  fetchFn?: FetchLike;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const provider = input.catalog.providers.find((row) => row.id === input.providerId);
  if (provider === undefined) {
    return { status: 404, body: { error: { kind: "provider-not-found", message: "provider not found" } } };
  }
  const secret = secretFor(input.secretStore, provider.id);
  if (secret === undefined) {
    return { status: 409, body: { error: { kind: "no-secret", message: "no API key stored for this provider" } } };
  }
  let result: FetchProviderResult;
  try {
    result = await fetchProviderModels({
      url: modelsUrl(provider.origin),
      secret,
      fetchFn: input.fetchFn ?? defaultFetch,
      totalTimeoutMs: PROVIDER_MODELS_TOTAL_TIMEOUT_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    return { status: 500, body: { error: { kind: "internal", message } } };
  }
  if (!result.ok) {
    const body: { error: { kind: string; message: string; upstreamStatus?: number } } = {
      error: { kind: result.errorKind, message: result.message },
    };
    if (result.upstreamStatus !== undefined) {
      body.error.upstreamStatus = result.upstreamStatus;
    }
    return { status: httpStatusFor(result.errorKind), body };
  }
  return {
    status: 200,
    body: {
      ok: true,
      providerId: provider.id,
      source: "provider",
      fetchedAt: new Date().toISOString(),
      skipped: result.skipped,
      skippedReasons: result.skippedReasons,
      models: result.models,
    },
  };
}
