/**
 * Typed domain models mirroring the backend wire contract.
 * Single source of truth for the UI's view of `/api/state`, `/api/save`,
 * the log endpoints, and the §8 model-fetch/catalog endpoints.
 */

export type ReasoningLevel = "default" | "none" | "low" | "medium" | "high" | "max" | "xhigh";
export type Modality = "text" | "image" | "video" | "audio";
export type LogChannel = "hop" | "official" | "custom-host";
export type LogChannelFilter = "official" | "custom";

export const REASONING_LEVELS: readonly ReasoningLevel[] = [
  "default",
  "none",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
];
export const DEFAULT_REASONING_LEVELS: readonly ReasoningLevel[] = [
  "default",
  "none",
  "low",
  "medium",
  "high",
];
export const MODALITIES: readonly Modality[] = ["text", "image", "video", "audio"];

export type Provider = {
  id: string;
  name: string;
  origin: string;
  maxTokensDefault: number;
  mapFile: string;
};

export type ProviderParameter = { id: string; value: string };

export type Model = {
  id: string;
  providerId: string;
  slug: string;
  contextTokens: number;
  maxOutputTokens: number;
  reasoningLevels: ReasoningLevel[];
  activeReasoning: ReasoningLevel;
  modalities: Modality[];
  parameters: ProviderParameter[];
};

export type WrapObserved =
  | { kind: "stock-unmarked" }
  | { kind: "openbot-marked"; marker: string }
  | { kind: "foreign-opengrok" }
  | { kind: "private-lane" }
  | { kind: "gap"; present: string; missing: string }
  | { kind: "ambiguous-factory"; functionDefs: number; propertyDefs: number };

export type PortObserved =
  | { kind: "ours"; pid: number; host: string; port: number }
  | { kind: "foreign"; pid: number; host: string; port: number }
  | { kind: "absent" };

export type HostObserved =
  | { kind: "running-owned"; pid: number }
  | { kind: "running-unowned"; pid: number }
  | { kind: "needs-term"; pid: number; bounceHint: string }
  | { kind: "absent" };

export type Alignment =
  | { kind: "ok"; desired: "official" | "custom"; wrap: string }
  | { kind: "needs-reinstall"; desired: "custom"; wrap: "stock-unmarked" };

export type TunnelState =
  | { kind: "off" }
  | { kind: "cloudflare-quick"; url: string; internal: string; pid: number; qr?: string }
  | { kind: "error"; message: string };

export type Snapshot = {
  wrap: WrapObserved;
  hopListen: PortObserved;
  uiListen: PortObserved;
  host: HostObserved;
  alignment: Alignment;
  tunnel: TunnelState;
};

export type LogSettings = {
  loggingEnabled: boolean;
  logBodies: boolean;
  logBodiesOnError: boolean;
  logRetentionDays: number;
  maxBodyCaptureBytes: number;
  maxRecords: number;
};

export type BoxState = {
  snapshot: Snapshot;
  providers: Provider[];
  models: Model[];
  keyedProviders: string[];
  activeModelId: string | null;
  logSettings: LogSettings;
};

export type SaveResult = BoxState & { ok: true; wrapBytesChanged: boolean };

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

export type LogRecord = {
  id: string;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  ok: boolean;
  status: number;
  channel?: LogChannel;
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

export type RefusalError =
  | { kind: "host-missing"; path: string }
  | { kind: "foreign-hop" }
  | { kind: "foreign-ui" }
  | { kind: "foreign-opengrok" }
  | { kind: "census-refused"; reason: string }
  | { kind: "syntax-check-failed"; stderr: string }
  | { kind: "listen-failed"; port: number };

/** §8.1 — a normalized model returned by `POST /api/providers/{id}/fetch-models`. */
export type FetchedModel = {
  id: string;
  name: string | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  /** Backend always sends an array; empty = unknown (PRD §8.1). */
  modalities: string[];
  /** Backend always sends an array; empty = use defaults (PRD §8.1). */
  reasoningLevels: string[];
};

export type FetchModelsResult = {
  ok: true;
  providerId: string;
  source: string;
  fetchedAt: string;
  skipped: number;
  skippedReasons: string[];
  models: FetchedModel[];
};

export type FetchModelsErrorKind =
  | "provider-not-found"
  | "no-secret"
  | "unauthorized"
  | "unreachable"
  | "not-supported"
  | "parse-error"
  | "internal";

export type FetchModelsError = {
  error: { kind: FetchModelsErrorKind; message: string; upstreamStatus?: number };
};

export type CatalogSource = {
  name: string;
  url: string;
  modelCount: number;
  lastFetched: string | null;
};

export type CatalogLookupModel = {
  id: string;
  name: string | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  modalities: string[];
  reasoning: boolean;
  pricing: { input: number | null; output: number | null; currency: string } | null;
};

export type ModelCatalog = {
  status: "ready" | "loading" | "failed";
  lastFetched: string | null;
  totalModels: number;
  sources: CatalogSource[];
  error?: { kind: string; message: string };
  lookup?: { found: boolean; model?: CatalogLookupModel };
};

export type RefreshCatalogResult = { ok: true; status: "loading"; startedAt: string };
