import { isReasoningLevel, limitsFromModel } from "./model";

export type Provider = {
  id: string;
  name: string;
  origin: string;
};

export type Model = {
  id: string;
  providerId: string;
  slug: string;
  contextTokens: number;
  maxOutputTokens: number;
  reasoningLevels: string[];
  activeReasoning: string;
  modalities: string[];
};

export type TunnelState =
  | { kind: "off" }
  | {
      kind: "cloudflare-quick";
      url: string;
      internal: string;
      pid: number;
      qr?: string;
    }
  | { kind: "error"; message: string };

export type Snapshot = {
  wrap: { kind: string };
  alignment?: { kind: string; desired?: string };
  tunnel?: TunnelState;
};

export type LogSettings = {
  loggingEnabled: boolean;
  logBodies: boolean;
  logBodiesOnError: boolean;
  logRetentionDays: number;
  maxBodyCaptureBytes: number;
  maxRecords: number;
};

export type LogRecord = {
  id: string;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  ok: boolean;
  status: number;
  model?: string;
  providerId?: string;
  providerName?: string;
  inboundEndpoint?: string;
  upstreamEndpoint?: string;
  stream?: boolean;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  hasRequest: boolean;
  hasResponse: boolean;
  requestTruncated?: boolean;
  responseTruncated?: boolean;
};

export type LogDetail = LogRecord & {
  request?: unknown;
  response?: unknown;
};

export type LogList = {
  items: LogRecord[];
  total: number;
  page: number;
  pageSize: number;
};

export type BoxState = {
  providers: Provider[];
  models: Model[];
  keyedProviders: string[];
  activeModelId: string | null;
  snapshot?: Snapshot;
  wrapBytesChanged?: boolean;
  logSettings?: LogSettings;
};

export type ModelLimitsPayload = {
  contextTokens?: number;
  maxOutputTokens?: number;
  reasoningLevels?: readonly string[];
  modalities?: readonly string[];
  activeReasoning?: string;
};

export type Command =
  | { kind: "official" }
  | ({
      kind: "upsert-provider";
      name: string;
      origin: string;
      modelSlug: string;
      secret: string;
    } & ModelLimitsPayload)
  | ({
      kind: "upsert-model";
      providerId: string;
      slug: string;
    } & ModelLimitsPayload)
  | { kind: "use-model"; modelId: string; reasoning?: string }
  | { kind: "remove-provider"; providerId: string }
  | { kind: "set-secret"; providerId: string; secret: string }
  | { kind: "update-provider"; providerId: string; name: string; origin: string; secret?: string }
  | { kind: "set-expose"; expose: "cloudflare" | "off" };

function asError(data: unknown, fallback: string): Error {
  if (typeof data === "object" && data !== null) {
    const record = data as { error?: unknown; message?: unknown };
    const nested = record.error;
    if (typeof nested === "string" && nested.trim()) {
      return new Error(nested);
    }
    if (typeof nested === "object" && nested !== null) {
      const inner = nested as { message?: unknown; kind?: unknown };
      if (typeof inner.message === "string" && inner.message.trim()) {
        return new Error(inner.message);
      }
      if (typeof inner.kind === "string" && inner.kind.trim()) {
        return new Error(inner.kind);
      }
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return new Error(record.message);
    }
  }
  return new Error(fallback);
}

function hydrateModel(row: Model): Model {
  const limits = limitsFromModel(row);
  const active = typeof row.activeReasoning === "string" ? row.activeReasoning : "";
  const activeReasoning =
    isReasoningLevel(active) && limits.reasoningLevels.includes(active)
      ? active
      : limits.reasoningLevels.includes("default")
        ? "default"
        : (limits.reasoningLevels[0] ?? "default");
  return {
    id: row.id,
    providerId: row.providerId,
    slug: row.slug,
    contextTokens: limits.contextTokens,
    maxOutputTokens: limits.maxOutputTokens,
    reasoningLevels: limits.reasoningLevels,
    activeReasoning,
    modalities: limits.modalities,
  };
}

function hydrateState(data: BoxState): BoxState {
  return {
    ...data,
    providers: Array.isArray(data.providers) ? data.providers : [],
    models: Array.isArray(data.models) ? data.models.map(hydrateModel) : [],
    keyedProviders: Array.isArray(data.keyedProviders) ? data.keyedProviders : [],
    activeModelId: data.activeModelId ?? null,
  };
}

async function readJson(url: string, options?: RequestInit): Promise<unknown> {
  const res = await fetch(url, options);
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new Error(text || res.statusText || "OpenBot could not read the response");
  }
  if (!res.ok) {
    throw asError(data, text || res.statusText || "Request failed");
  }
  return data;
}

async function getJson(url: string, options?: RequestInit): Promise<BoxState> {
  return hydrateState((await readJson(url, options)) as BoxState);
}

export async function loadState(): Promise<BoxState> {
  return getJson("/api/state");
}

export async function save(command: Command): Promise<BoxState> {
  return getJson("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
}

export async function loadLogSettings(): Promise<LogSettings> {
  return (await readJson("/api/logs/settings")) as LogSettings;
}

export async function saveLogSettings(settings: LogSettings): Promise<LogSettings> {
  return (await readJson("/api/logs/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  })) as LogSettings;
}

export async function listLogs(query: {
  q?: string;
  ok?: boolean;
  model?: string;
  page?: number;
  pageSize?: number;
}): Promise<LogList> {
  const params = new URLSearchParams();
  if (query.q) {
    params.set("q", query.q);
  }
  if (query.ok === true) {
    params.set("ok", "true");
  }
  if (query.ok === false) {
    params.set("ok", "false");
  }
  if (query.model) {
    params.set("model", query.model);
  }
  if (query.page !== undefined) {
    params.set("page", String(query.page));
  }
  if (query.pageSize !== undefined) {
    params.set("pageSize", String(query.pageSize));
  }
  const suffix = params.toString();
  const data = (await readJson(suffix ? `/api/logs?${suffix}` : "/api/logs")) as LogList;
  return {
    items: Array.isArray(data.items) ? data.items : [],
    total: typeof data.total === "number" ? data.total : 0,
    page: typeof data.page === "number" ? data.page : 1,
    pageSize: typeof data.pageSize === "number" ? data.pageSize : 50,
  };
}

export async function getLog(id: string): Promise<LogDetail> {
  return (await readJson(`/api/logs/${encodeURIComponent(id)}`)) as LogDetail;
}

export async function clearLogs(): Promise<void> {
  await readJson("/api/logs/clear", { method: "POST" });
}

export function isCustom(state: BoxState): boolean {
  if (state.snapshot?.alignment?.desired === "official") {
    return false;
  }
  return state.snapshot?.wrap.kind === "openbot-marked";
}

export function modelsFor(state: BoxState, providerId: string): Model[] {
  return state.models.filter((row) => row.providerId === providerId);
}

export function providerById(state: BoxState, providerId: string): Provider | undefined {
  return state.providers.find((row) => row.id === providerId);
}

export function modelById(state: BoxState, modelId: string | null): Model | undefined {
  if (!modelId) {
    return undefined;
  }
  return state.models.find((row) => row.id === modelId);
}

export function keyedSet(state: BoxState): Set<string> {
  return new Set(state.keyedProviders);
}

export function hostBlocked(state: BoxState): string | null {
  const kind = state.snapshot?.wrap.kind;
  if (!kind || kind === "stock-unmarked" || kind === "openbot-marked") {
    return null;
  }
  if (kind === "foreign-opengrok") {
    return "Another overlay is still attached to Grok Bot. OpenBot left it alone.";
  }
  return "The Grok Bot host on this Computer is not stock 0.30, so OpenBot will not attach.";
}
