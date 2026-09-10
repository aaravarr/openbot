import { createHash } from "node:crypto";
import { type Catalog, MAX_OUTPUT_TOKENS_CEILING } from "../domain/types.ts";
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
export const OPENAI_CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.153.3";
const OPENAI_CODEX_USER_AGENT = "codex-tui/0.153.3 (Mac OS 26.5.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.153.3)";

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

/**
 * Max-output variant: values above MAX_OUTPUT_TOKENS_CEILING are upstream
 * data corruption (context-window figures in a max-completion field), so
 * they are skipped in favor of the next candidate instead of poisoning the
 * fetched row.
 */
function firstSaneOutputTokens(...values: unknown[]): number | null {
  for (const value of values) {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(n) && n > 0 && n <= MAX_OUTPUT_TOKENS_CEILING) {
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

function modelIdFrom(item: Record<string, unknown>): string | null {
  const value = item.id ?? item.slug;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeEntry(item: Record<string, unknown>, id: string): FetchedModel {
  const architecture = nestedRecord(item, "architecture");
  const topProvider = nestedRecord(item, "top_provider");
  return {
    id,
    name: stringOrNull(item.name ?? item.display_name),
    contextLength: firstPositiveInt(item.context_length, item.contextLength, architecture?.context_length),
    maxOutputTokens: firstSaneOutputTokens(
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
    const id = modelIdFrom(item);
    if (id === null) {
      skippedReasons.push("missing-id");
      continue;
    }
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

function opencodeModelsSession(providerId: string): string {
  return createHash("sha256").update("openbot-opencode-models\0" + providerId, "utf8").digest("hex").slice(0, 32);
}

function openAIOAuthAccountId(secret: string): string {
  try {
    const credential = JSON.parse(secret) as Record<string, unknown>;
    if (credential.kind !== "openai-oauth") return "";
    if (typeof credential.chatgptAccountId === "string" && credential.chatgptAccountId.trim()) return credential.chatgptAccountId.trim();
    for (const token of [credential.idToken, credential.accessToken]) {
      if (typeof token !== "string") continue;
      const parts = token.split(".");
      if (parts.length < 2) continue;
      const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
      const auth = claims["https://api.openai.com/auth"];
      if (auth && typeof auth === "object" && !Array.isArray(auth) && typeof (auth as Record<string, unknown>).chatgpt_account_id === "string") {
        return ((auth as Record<string, unknown>).chatgpt_account_id as string).trim();
      }
    }
  } catch {
    // API-key secrets are not JSON credentials.
  }
  return "";
}

function isOpenAIOAuthSecret(secret: string): boolean {
  try {
    const credential = JSON.parse(secret) as Record<string, unknown>;
    return credential.kind === "openai-oauth" && typeof credential.accessToken === "string";
  } catch {
    return false;
  }
}

async function fetchProviderModels(input: {
  url: string;
  secret: string;
  providerId: string;
  headers?: Record<string, string>;
  fetchFn: FetchLike;
  totalTimeoutMs: number;
}): Promise<FetchProviderResult> {
  let oauthAccessToken: string | null = null;
  if (input.providerId === "openai") {
    try {
      const credential = JSON.parse(input.secret) as Record<string, unknown>;
      if (credential.kind === "openai-oauth" && typeof credential.accessToken === "string") {
        oauthAccessToken = credential.accessToken;
      }
    } catch {
      // API-key secrets are intentionally opaque.
    }
  }
  let res: { readonly status: number; readonly ok: boolean; text(): Promise<string> };
  try {
    res = await input.fetchFn(input.url, {
      headers: {
        ...(input.headers ?? {}),
        ...((oauthAccessToken ?? input.secret) ? { Authorization: "Bearer " + (oauthAccessToken ?? input.secret) } : {}),
        Accept: "application/json",
        ...(input.providerId === "opencode" ? { "x-opencode-session": opencodeModelsSession(input.providerId) } : {}),
      },
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
    const isOpenAIOAuth = provider.id === "openai" && isOpenAIOAuthSecret(secret);
    result = await fetchProviderModels({
      url: isOpenAIOAuth ? OPENAI_CODEX_MODELS_URL : modelsUrl(provider.origin),
      secret: secret ?? "",
      providerId: provider.id,
      ...(isOpenAIOAuth
        ? {
            headers: {
              "user-agent": OPENAI_CODEX_USER_AGENT,
              originator: "codex-tui",
              ...(openAIOAuthAccountId(secret) ? { "chatgpt-account-id": openAIOAuthAccountId(secret) } : {}),
            },
          }
        : {}),
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
