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

export const REASONING_LEVELS: readonly ReasoningLevel[] = [
  "default",
  "none",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
];
export const DEFAULT_REASONING_LEVELS: readonly ReasoningLevel[] = ["default", "none", "low", "medium", "high"];
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

function keepReasoningOrder(selected: ReadonlySet<string>): ReasoningLevel[] {
  return REASONING_LEVELS.filter((item) => selected.has(item));
}

export function parseReasoningLevels(value: unknown): readonly ReasoningLevel[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/u) : [];
  const seen = new Set<string>();
  let listed = false;
  for (const item of raw) {
    const level = parseReasoningLevel(item);
    if (!level || seen.has(level)) {
      continue;
    }
    listed = true;
    seen.add(level);
  }
  if (!listed) {
    return DEFAULT_REASONING_LEVELS;
  }
  if (!seen.has("default")) {
    seen.add("default");
  }
  return keepReasoningOrder(seen);
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

function rawLevelsHadDefault(value: unknown): boolean {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/u) : [];
  return raw.some((item) => parseReasoningLevel(item) === "default");
}

export function pickActiveReasoning(
  levels: readonly ReasoningLevel[],
  requested: unknown,
  rawLevels?: unknown,
): ReasoningLevel {
  const wanted = parseReasoningLevel(requested);
  const oldCatalog = rawLevels !== undefined && !rawLevelsHadDefault(rawLevels);
  if (oldCatalog && (wanted === undefined || wanted === "none")) {
    if (levels.includes("default")) {
      return "default";
    }
  }
  if (wanted && levels.includes(wanted)) {
    return wanted;
  }
  if (levels.includes("default")) {
    return "default";
  }
  if (levels.includes("none")) {
    return "none";
  }
  return levels[0] ?? "default";
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
    activeReasoning: pickActiveReasoning(reasoningLevels, input.activeReasoning, input.reasoningLevels),
    modalities: parseModalities(input.modalities),
    parameters: input.parameters ?? [],
  };
}

function isRecord(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeModel(raw: unknown): Model | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.providerId !== "string" || typeof row.slug !== "string") {
    return undefined;
  }
  const parameters = Array.isArray(row.parameters)
    ? row.parameters.filter((item): item is ProviderParameter => {
        return (
          item !== null &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof (item as { id?: unknown }).id === "string" &&
          typeof (item as { value?: unknown }).value === "string"
        );
      })
    : [];
  return makeModel({
    id: row.id as ModelId,
    providerId: row.providerId as ProviderId,
    slug: row.slug as Model["slug"],
    contextTokens: row.contextTokens,
    maxOutputTokens: row.maxOutputTokens,
    reasoningLevels: row.reasoningLevels,
    activeReasoning: row.activeReasoning,
    modalities: row.modalities,
    parameters,
  });
}

export function hasSelectableReasoning(model: {
  reasoningLevels: readonly ReasoningLevel[];
}): boolean {
  return model.reasoningLevels.some((level) => level !== "default");
}
