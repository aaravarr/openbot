import {
  HIGH_AGENT_MAX_TOKENS,
  type Model,
  type ModelId,
  type Modality,
  type ProviderId,
  type ProviderParameter,
  type ReasoningLevel,
} from "./types.ts";

export const DEFAULT_CONTEXT_TOKENS = 128000 as const;
export const MAX_TOKEN_CAP = 10_000_000 as const;

export const REASONING_LEVELS: readonly ReasoningLevel[] = ["none", "low", "medium", "high", "max", "xhigh"];
export const DEFAULT_REASONING_LEVELS: readonly ReasoningLevel[] = ["none", "low", "medium", "high"];
export const MODALITIES: readonly Modality[] = ["text", "image", "video", "audio"];
export const DEFAULT_MODALITIES: readonly Modality[] = ["text"];

const REASONING_SET = new Set<string>(REASONING_LEVELS);
const MODALITY_SET = new Set<string>(MODALITIES);

export function parsePositiveTokens(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_TOKEN_CAP) {
    return fallback;
  }
  return Math.floor(n);
}

export function parseReasoningLevel(value: unknown): ReasoningLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const token = value.trim().toLowerCase();
  if (!REASONING_SET.has(token)) {
    return undefined;
  }
  return token as ReasoningLevel;
}

export function parseReasoningLevels(value: unknown): readonly ReasoningLevel[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/u) : [];
  const out: ReasoningLevel[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const level = parseReasoningLevel(item);
    if (!level || seen.has(level)) {
      continue;
    }
    seen.add(level);
    out.push(level);
  }
  return out.length ? out : DEFAULT_REASONING_LEVELS;
}

export function parseModalities(value: unknown): readonly Modality[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/u) : [];
  const out: Modality[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const token = item.trim().toLowerCase();
    if (!MODALITY_SET.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(token as Modality);
  }
  return out.length ? out : DEFAULT_MODALITIES;
}

export function pickActiveReasoning(
  levels: readonly ReasoningLevel[],
  requested: unknown,
): ReasoningLevel {
  const wanted = parseReasoningLevel(requested);
  if (wanted && levels.includes(wanted)) {
    return wanted;
  }
  if (levels.includes("none")) {
    return "none";
  }
  return levels[0] ?? "none";
}

export function makeModel(input: {
  id: ModelId;
  providerId: ProviderId;
  slug: Model["slug"];
  contextTokens?: unknown;
  maxOutputTokens?: unknown;
  reasoningLevels?: unknown;
  activeReasoning?: unknown;
  modalities?: unknown;
  parameters?: readonly ProviderParameter[];
}): Model {
  const reasoningLevels = parseReasoningLevels(input.reasoningLevels);
  return {
    id: input.id,
    providerId: input.providerId,
    slug: input.slug,
    contextTokens: parsePositiveTokens(input.contextTokens, DEFAULT_CONTEXT_TOKENS),
    maxOutputTokens: parsePositiveTokens(input.maxOutputTokens, HIGH_AGENT_MAX_TOKENS),
    reasoningLevels,
    activeReasoning: pickActiveReasoning(reasoningLevels, input.activeReasoning),
    modalities: parseModalities(input.modalities),
    parameters: input.parameters ?? [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeModel(raw: unknown): Model | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.providerId !== "string" || typeof raw.slug !== "string") {
    return undefined;
  }
  const parameters = Array.isArray(raw.parameters)
    ? raw.parameters.filter((row): row is ProviderParameter => {
        return isRecord(row) && typeof row.id === "string" && typeof row.value === "string";
      })
    : [];
  return makeModel({
    id: raw.id as ModelId,
    providerId: raw.providerId as ProviderId,
    slug: raw.slug as Model["slug"],
    contextTokens: raw.contextTokens,
    maxOutputTokens: raw.maxOutputTokens,
    reasoningLevels: raw.reasoningLevels,
    activeReasoning: raw.activeReasoning,
    modalities: raw.modalities,
    parameters,
  });
}

export function hasSelectableReasoning(model: {
  reasoningLevels: readonly ReasoningLevel[];
}): boolean {
  return model.reasoningLevels.some((level) => level !== "none");
}
