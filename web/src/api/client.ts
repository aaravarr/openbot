/**
 * Typed API client for the loopback control service.
 *
 * Isolated in one file so backend-integration fixes are single-file changes.
 * Everything lives on the same origin as the served UI (no CORS, no base URL).
 */
import type {
  BoxState,
  Command,
  FetchModelsError,
  FetchModelsErrorKind,
  FetchModelsResult,
  LogChannelFilter,
  LogDetail,
  LogList,
  LogRecord,
  LogSettings,
  ModelCatalog,
  RefreshCatalogResult,
  RefusalError,
  SaveResult,
} from "./types";

/** A structured failure carrying the machine contract (status + kind). */
export class ApiError extends Error {
  readonly status: number;
  readonly kind?: string;
  readonly refusal?: RefusalError;
  readonly fetchKind?: FetchModelsErrorKind;
  readonly upstreamStatus?: number;

  constructor(message: string, init: { status: number; kind?: string; refusal?: RefusalError; fetchKind?: FetchModelsErrorKind; upstreamStatus?: number }) {
    super(message);
    this.name = "ApiError";
    this.status = init.status;
    this.kind = init.kind;
    this.refusal = init.refusal;
    this.fetchKind = init.fetchKind;
    this.upstreamStatus = init.upstreamStatus;
  }
}

function extractMessage(data: unknown, fallback: string): string {
  if (typeof data === "object" && data !== null) {
    const record = data as { error?: unknown; message?: unknown };
    const nested = record.error;
    if (typeof nested === "string" && nested.trim()) {
      return nested;
    }
    if (typeof nested === "object" && nested !== null) {
      const inner = nested as { message?: unknown; kind?: unknown };
      if (typeof inner.message === "string" && inner.message.trim()) {
        return inner.message;
      }
      if (typeof inner.kind === "string" && inner.kind.trim()) {
        return inner.kind;
      }
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
  }
  return fallback;
}

function extractRefusal(data: unknown): RefusalError | undefined {
  if (typeof data === "object" && data !== null) {
    const record = data as { kind?: unknown; error?: unknown };
    if (record.kind === "refused" && typeof record.error === "object" && record.error !== null) {
      const inner = record.error as { kind?: unknown };
      if (typeof inner.kind === "string") {
        return inner as unknown as RefusalError;
      }
    }
  }
  return undefined;
}

async function request(url: string, options?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    throw new ApiError(err instanceof Error ? err.message : "Could not reach OpenBot", { status: 0 });
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const refusal = extractRefusal(data);
    const fetchKind = extractFetchKind(data);
    throw new ApiError(extractMessage(data, text || res.statusText || "Request failed"), {
      status: res.status,
      kind: refusal?.kind ?? fetchKind,
      refusal,
      fetchKind,
      upstreamStatus: fetchUpstreamStatus(data),
    });
  }
  return data;
}

function extractFetchKind(data: unknown): FetchModelsErrorKind | undefined {
  if (typeof data === "object" && data !== null) {
    const nested = (data as { error?: unknown }).error;
    if (typeof nested === "object" && nested !== null) {
      const kind = (nested as { kind?: unknown }).kind;
      if (typeof kind === "string") {
        return kind as FetchModelsErrorKind;
      }
    }
  }
  return undefined;
}

function fetchUpstreamStatus(data: unknown): number | undefined {
  if (typeof data === "object" && data !== null) {
    const nested = (data as { error?: unknown }).error;
    if (typeof nested === "object" && nested !== null) {
      const s = (nested as { upstreamStatus?: unknown }).upstreamStatus;
      if (typeof s === "number") {
        return s;
      }
    }
  }
  return undefined;
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function loadState(): Promise<BoxState> {
  return (await request("/api/state")) as BoxState;
}

export async function save(command: Command): Promise<SaveResult> {
  return (await request("/api/save", jsonInit(command))) as SaveResult;
}

export async function healthz(): Promise<{ ok: true; service: string }> {
  return (await request("/healthz")) as { ok: true; service: string };
}

/* ---- §8.1 Source A: fetch a provider's model list ---- */
export async function fetchProviderModels(providerId: string): Promise<FetchModelsResult> {
  return (await request(`/api/providers/${encodeURIComponent(providerId)}/fetch-models`, jsonInit({}))) as FetchModelsResult;
}

/* ---- §8.2 / §8.3 Source B: model catalog ---- */
export async function getModelCatalog(modelId?: string): Promise<ModelCatalog> {
  const q = modelId ? `?modelId=${encodeURIComponent(modelId)}` : "";
  return (await request(`/api/model-catalog${q}`)) as ModelCatalog;
}

export async function refreshModelCatalog(): Promise<RefreshCatalogResult> {
  return (await request("/api/model-catalog/refresh", jsonInit({}))) as RefreshCatalogResult;
}

/* ---- Logs ---- */
export async function loadLogSettings(): Promise<LogSettings> {
  return (await request("/api/logs/settings")) as LogSettings;
}

export async function saveLogSettings(
  settings: Partial<LogSettings>,
): Promise<LogSettings & { wrapBytesChanged?: boolean; wrapError?: string }> {
  return (await request("/api/logs/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  })) as LogSettings & { wrapBytesChanged?: boolean; wrapError?: string };
}

export type LogQuery = {
  q?: string;
  ok?: boolean;
  channel?: LogChannelFilter;
  model?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

export async function listLogs(query: LogQuery = {}): Promise<LogList> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.ok === true) params.set("ok", "true");
  if (query.ok === false) params.set("ok", "false");
  if (query.channel) params.set("channel", query.channel);
  if (query.model) params.set("model", query.model);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  const suffix = params.toString();
  const data = (await request(suffix ? `/api/logs?${suffix}` : "/api/logs")) as LogList;
  return {
    items: Array.isArray(data.items) ? (data.items as LogRecord[]) : [],
    total: typeof data.total === "number" ? data.total : 0,
    page: typeof data.page === "number" ? data.page : 1,
    pageSize: typeof data.pageSize === "number" ? data.pageSize : 50,
  };
}

export async function getLog(id: string): Promise<LogDetail> {
  return (await request(`/api/logs/${encodeURIComponent(id)}`)) as LogDetail;
}

export async function clearLogs(): Promise<{ ok: true }> {
  return (await request("/api/logs/clear", jsonInit({}))) as { ok: true };
}

/* ---- Derived helpers ---- */
export function isCustom(state: BoxState): boolean {
  return state.snapshot.alignment.desired === "custom";
}

export function modelById(state: BoxState, modelId: string | null | undefined): (typeof state.models)[number] | undefined {
  if (!modelId) return undefined;
  return state.models.find((row) => row.id === modelId);
}

export function providerById(state: BoxState, providerId: string | null | undefined): (typeof state.providers)[number] | undefined {
  if (!providerId) return undefined;
  return state.providers.find((row) => row.id === providerId);
}

export function keyedSet(state: BoxState): Set<string> {
  return new Set(state.keyedProviders);
}

export function hasKey(state: BoxState, providerId: string): boolean {
  return keyedSet(state).has(providerId);
}

/** Returns a blocking reason string when the host is hostile, else null. */
export function hostBlocked(state: BoxState): RefusalError | null {
  const wrap = state.snapshot.wrap;
  switch (wrap.kind) {
    case "stock-unmarked":
    case "openbot-marked":
      return null;
    case "foreign-opengrok":
      return { kind: "foreign-opengrok" };
    case "private-lane":
      return { kind: "census-refused", reason: `cannot wrap a private-lane host` };
    case "gap":
      return { kind: "census-refused", reason: `cannot wrap a gap host (${wrap.present} → ${wrap.missing})` };
    case "ambiguous-factory":
      return { kind: "census-refused", reason: `cannot wrap an ambiguous-factory host` };
    default:
      return null;
  }
}
