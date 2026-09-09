/**
 * Typed domain models mirroring the backend wire contract.
 * Single source of truth for the UI's view of `/api/state`, `/api/save`,
 * the log endpoints, and the §8 model-fetch/catalog endpoints.
 */

export type ReasoningLevel = "default" | "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type Modality = "text" | "image" | "video" | "audio";
export type LogChannel = "hop" | "official" | "custom-host";
export type LogChannelFilter = "official" | "custom";

export const REASONING_LEVELS: readonly ReasoningLevel[] = [
  "default",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
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
  apiType?: "chat-completions" | "responses" | "anthropic";
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

export type BotModels = { assignments: Record<string, string>; available: string[] };

export type SaveResult = BoxState & { ok: true; wrapBytesChanged: boolean };

export type GatewayPause = {
  paused: boolean;
  at: string | null;
  note: string | null;
};

export type BotInfo = { botId: string; botName: string };
export type PauseBotsState = { pausedBotIds: string[] };

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
      apiType?: "chat-completions" | "responses" | "anthropic";
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
  | { kind: "remove-model"; modelId: string }
  | { kind: "set-secret"; providerId: string; secret: string }
  | { kind: "update-provider"; providerId: string; name: string; origin: string; apiType?: "chat-completions" | "responses" | "anthropic"; secret?: string }
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
  /** Request source stamped by the logger; absent on rows written before it existed. */
  clientName?: string;
  clientVersion?: string;
  conversationId?: string;
  userAgent?: string;
  botId?: string;
  botName?: string;
  chatType?: "group" | "dm" | "routine";
  chatName?: string;
};

export type LogDetail = LogRecord & {
  request?: unknown;
  response?: unknown;
  /** Full redacted body text for copy buttons; present only on truncated records. */
  requestFull?: string;
  /** Full redacted body text for copy buttons; present only on truncated records. */
  responseFull?: string;
  /** Legacy alias some backends use for `request`. */
  requestBody?: unknown;
  /** Legacy alias some backends use for `response`. */
  responseBody?: unknown;
};

export type LogList = {
  items: LogRecord[];
  total: number;
  page: number;
  pageSize: number;
  /** JSONL files are prune-bounded, so list counts stay exact. */
  approximate?: boolean;
};

export type LogStats = {
  records: number;
  scanned: number;
  approximate: boolean;
  ok: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  bodyBytes: number;
  bodyFiles: number;
  bodyDiskBytes: number;
  bodiesApproximate: boolean;
  diskBytes: number;
};

export type LogFacetOption = { value: string; count: number };
 
/** One aggregated usage row from GET /api/logs/usage (`byDay` / `byModel` share this shape). */
export type LogUsageRow = {
  key: string;
  requests: number;
  ok: number;
  fail: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  avgLatencyMs?: number;
  avgFirstTokenMs?: number;
  avgTps?: number;
};

export type LogUsageSummary = LogUsageRow & { successRate: number; cacheHitRate: number };

/** Usage payload from GET /api/logs/usage; `approximate` renders as the “约” marker in the UI. */
export type LogUsage = {
  approximate: boolean;
  scanned: number;
  total: number;
  from: string;
  to: string;
  byDay: LogUsageRow[];
  byModel: LogUsageRow[];
  /** Legacy alias kept for loose compat with older payloads; prefer byDay/byModel. */
  rows?: LogUsageRow[];
  summary?: LogUsageSummary;
  buckets?: LogUsageRow[];
  bucketMs?: number;
};

export type LogFacets = {
  sampled: number;
  total: number;
  model: { values: LogFacetOption[]; approximate: boolean };
  provider: { values: LogFacetOption[]; approximate: boolean };
  channel: { values: LogFacetOption[]; approximate: boolean };
  status: { values: LogFacetOption[]; approximate: boolean };
  bots: Array<{ botId?: string; botName?: string }>;
  chatTypes: Array<"group" | "dm" | "routine">;
};

export type LogEvent = {
  id: string;
  at: string;
  type: string;
  severity: "INFO" | "WARN" | "ERROR";
  message: string;
  requestId?: string;
  metadata?: unknown;
};

export type LogEventList = {
  items: LogEvent[];
  total: number;
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
  /** Ordered allow-list from Source B; empty or omitted on a boolean-only cache. */
  reasoningLevels?: readonly string[];
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

export type GrokSkillState = "missing" | "stale" | "current" | "unavailable" | "blocked";

export type GrokSkill = {
  slug: string;
  name: string;
  state: GrokSkillState;
  destPath: string;
};

export type GrokSkillsReport = {
  dest: string;
  source: "github" | "local" | "none";
  ref?: string;
  skills: GrokSkill[];
};
