export const REASONING_LEVELS = ["default", "none", "low", "medium", "high", "max", "xhigh"] as const;
export const DEFAULT_REASONING_LEVELS = ["default", "none", "low", "medium", "high"] as const;
export const MODALITIES = ["text", "image", "video", "audio"] as const;
export const DEFAULT_MODALITIES = ["text"] as const;
export const DEFAULT_CONTEXT_TOKENS = 128000;
export const DEFAULT_MAX_OUTPUT = 65536;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
export type Modality = (typeof MODALITIES)[number];

export type ModelLimits = {
  contextTokens: number;
  maxOutputTokens: number;
  reasoningLevels: ReasoningLevel[];
  modalities: Modality[];
  activeReasoning: ReasoningLevel;
};

const REASONING_SET = new Set<string>(REASONING_LEVELS);
const MODALITY_SET = new Set<string>(MODALITIES);

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return REASONING_SET.has(value);
}

export function isModality(value: string): value is Modality {
  return MODALITY_SET.has(value);
}

export function defaultLimits(): ModelLimits {
  return {
    contextTokens: DEFAULT_CONTEXT_TOKENS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    reasoningLevels: [...DEFAULT_REASONING_LEVELS],
    modalities: [...DEFAULT_MODALITIES],
    activeReasoning: "default",
  };
}

export function labelReasoning(level: string): string {
  if (level === "xhigh") {
    return "Extra high";
  }
  if (level === "default") {
    return "Default";
  }
  if (level === "none") {
    return "Off";
  }
  return level.slice(0, 1).toUpperCase() + level.slice(1);
}

export function labelModality(item: string): string {
  return item.slice(0, 1).toUpperCase() + item.slice(1);
}

export function hasSelectableReasoning(levels: readonly string[] | undefined): boolean {
  return Array.isArray(levels) && levels.some((level) => level !== "default");
}

function keepOrder<T extends string>(universe: readonly T[], selected: ReadonlySet<string>): T[] {
  return universe.filter((item) => selected.has(item));
}

export function toggleReasoning(list: readonly ReasoningLevel[], level: ReasoningLevel): ReasoningLevel[] {
  if (level === "default") {
    return keepOrder(REASONING_LEVELS, new Set([...list, "default"]));
  }
  const set = new Set(list);
  if (set.has(level)) {
    if (set.size === 1) {
      return keepOrder(REASONING_LEVELS, new Set([...list, "default"]));
    }
    set.delete(level);
  } else {
    set.add(level);
  }
  set.add("default");
  return keepOrder(REASONING_LEVELS, set);
}

export function coerceActiveReasoning(
  levels: readonly ReasoningLevel[],
  requested: string | undefined,
): ReasoningLevel {
  if (requested && isReasoningLevel(requested) && levels.includes(requested)) {
    return requested;
  }
  if (levels.includes("default")) {
    return "default";
  }
  return levels[0] ?? "default";
}

export function withReasoningToggle(limits: ModelLimits, level: ReasoningLevel): ModelLimits {
  const reasoningLevels = toggleReasoning(limits.reasoningLevels, level);
  return {
    ...limits,
    reasoningLevels,
    activeReasoning: coerceActiveReasoning(reasoningLevels, limits.activeReasoning),
  };
}

export function toggleModality(list: readonly Modality[], item: Modality): Modality[] {
  const set = new Set(list);
  if (set.has(item)) {
    if (set.size === 1) {
      return [...list];
    }
    set.delete(item);
  } else {
    set.add(item);
  }
  return keepOrder(MODALITIES, set);
}

export function formatTokens(value: number): string {
  if (value >= 1000 && value % 1000 === 0) {
    return `${String(value / 1000)}k`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/u, "")}k`;
  }
  return String(value);
}

export function formatModelMeta(model: {
  contextTokens?: number;
  maxOutputTokens?: number;
  modalities?: readonly string[];
}): string {
  const limits = limitsFromModel(model);
  return `${formatTokens(limits.contextTokens)} context · ${formatTokens(limits.maxOutputTokens)} output · ${limits.modalities.join(", ")}`;
}

export function limitsFromModel(model: {
  contextTokens?: number;
  maxOutputTokens?: number;
  reasoningLevels?: readonly string[];
  modalities?: readonly string[];
  activeReasoning?: string;
}): ModelLimits {
  const filtered = (model.reasoningLevels ?? DEFAULT_REASONING_LEVELS).filter(isReasoningLevel);
  const withDefault = filtered.includes("default") ? filtered : (["default", ...filtered] as ReasoningLevel[]);
  const modalities = (model.modalities ?? DEFAULT_MODALITIES).filter(isModality);
  const reasoningLevels = withDefault.length ? withDefault : [...DEFAULT_REASONING_LEVELS];
  return {
    contextTokens: model.contextTokens && model.contextTokens > 0 ? model.contextTokens : DEFAULT_CONTEXT_TOKENS,
    maxOutputTokens: model.maxOutputTokens && model.maxOutputTokens > 0 ? model.maxOutputTokens : DEFAULT_MAX_OUTPUT,
    reasoningLevels,
    modalities: modalities.length ? modalities : [...DEFAULT_MODALITIES],
    activeReasoning: coerceActiveReasoning(reasoningLevels, model.activeReasoning),
  };
}

export function limitsSignature(model: {
  id?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  reasoningLevels?: readonly string[];
  modalities?: readonly string[];
  activeReasoning?: string;
}): string {
  const limits = limitsFromModel(model);
  return [
    model.id ?? "",
    String(limits.contextTokens),
    String(limits.maxOutputTokens),
    limits.reasoningLevels.join(","),
    limits.modalities.join(","),
    limits.activeReasoning,
  ].join("|");
}
