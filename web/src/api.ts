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
  alignment?: { kind: string };
  tunnel?: TunnelState;
};

export type BoxState = {
  providers: Provider[];
  models: Model[];
  keyedProviders: string[];
  activeModelId: string | null;
  snapshot?: Snapshot;
  wrapBytesChanged?: boolean;
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

async function getJson(url: string, options?: RequestInit): Promise<BoxState> {
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
  return hydrateState(data as BoxState);
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

export function isCustom(state: BoxState): boolean {
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
