import { keepReasoningOrder, parseReasoningLevel } from "../domain/model.ts";
import { type ReasoningLevel } from "../domain/types.ts";

/**
 * Vendor effort token → OpenBot reasoning level. `xhigh` and `max` stay distinct
 * chips; unknown tokens are dropped. Do not use `parseReasoningLevels` here —
 * an empty list becomes DEFAULT_REASONING_LEVELS, which is wrong for catalog.
 */

const VENDOR_EFFORT_TO_LEVEL: { readonly [token: string]: ReasoningLevel } = {
  default: "default",
  none: "none",
  off: "none",
  disabled: "none",
  low: "low",
  minimal: "low",
  min: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  xhigh: "xhigh",
  "x-high": "xhigh",
  "extra-high": "xhigh",
  extra_high: "xhigh",
  max: "max",
};

/** Fallback when reasoning is on but the vendor listed no efforts and no toggle. */
export const LEGACY_CATALOG_REASONING: readonly ReasoningLevel[] = ["default", "none", "high"];

export type VendorReasoningFacts = {
  readonly reasoning: boolean | undefined;
  readonly mandatory: boolean;
  readonly hasToggle: boolean;
  readonly effortTokens: readonly unknown[];
};

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

export function mapVendorEffort(token: unknown): ReasoningLevel | undefined {
  if (typeof token !== "string") {
    return undefined;
  }
  const key = token.trim().toLowerCase();
  if (!key) {
    return undefined;
  }
  return VENDOR_EFFORT_TO_LEVEL[key];
}

function mappedEfforts(tokens: readonly unknown[]): ReasoningLevel[] {
  const seen = new Set<string>();
  for (const token of tokens) {
    const level = mapVendorEffort(token);
    if (level !== undefined) {
      seen.add(level);
    }
  }
  return keepReasoningOrder(seen);
}

/**
 * Pull OpenRouter `reasoning.supported_efforts` / `mandatory`, models.dev
 * `reasoning_options`, and Source A `reasoningLevels` / `reasoning_levels`
 * off a vendor model object.
 */
export function vendorReasoningFacts(item: unknown): VendorReasoningFacts {
  if (!isRecord(item)) {
    return { reasoning: undefined, mandatory: false, hasToggle: false, effortTokens: [] };
  }
  const effortTokens: unknown[] = [];
  const listed = firstArray(item.reasoningLevels, item.reasoning_levels);
  if (listed !== undefined) {
    effortTokens.push(...listed);
  }

  let reasoning: boolean | undefined;
  let mandatory = false;
  const reasoningField = item.reasoning;
  if (reasoningField === true) {
    reasoning = true;
  } else if (reasoningField === false) {
    reasoning = false;
  } else if (isRecord(reasoningField)) {
    reasoning = true;
    if (reasoningField.mandatory === true) {
      mandatory = true;
    }
    const efforts = firstArray(reasoningField.supported_efforts, reasoningField.supportedEfforts);
    if (efforts !== undefined) {
      effortTokens.push(...efforts);
    }
  }

  let hasToggle = false;
  const options = firstArray(item.reasoning_options, item.reasoningOptions);
  if (options !== undefined) {
    for (const option of options) {
      if (!isRecord(option)) {
        continue;
      }
      if (option.type === "toggle") {
        hasToggle = true;
      }
      if (option.type === "effort") {
        const values = firstArray(option.values);
        if (values !== undefined) {
          effortTokens.push(...values);
        }
      }
    }
  }

  return { reasoning, mandatory, hasToggle, effortTokens };
}

/**
 * Build the OpenBot allow-list from vendor facts.
 * Always keeps `default`. Does not invent `xhigh` / `max`.
 */
export function buildReasoningAllowList(
  facts: VendorReasoningFacts,
  hintHasReasoning = false,
): readonly ReasoningLevel[] {
  const mapped = mappedEfforts(facts.effortTokens);
  const hasEffortList = mapped.length > 0;
  const reasoningOn = facts.reasoning === true || hintHasReasoning;

  if (!reasoningOn && !hasEffortList && !facts.hasToggle) {
    return ["default"];
  }

  if (!hasEffortList && !facts.hasToggle) {
    if (facts.mandatory) {
      return ["default", "high"];
    }
    return [...LEGACY_CATALOG_REASONING];
  }

  const seen = new Set<string>(["default", ...mapped]);
  if (facts.mandatory) {
    seen.delete("none");
  } else {
    seen.add("none");
  }
  return keepReasoningOrder(seen);
}

export function unionReasoningLevels(
  existing: readonly string[],
  incoming: readonly string[],
): readonly ReasoningLevel[] {
  const seen = new Set<string>();
  for (const item of [...existing, ...incoming]) {
    const level = parseReasoningLevel(item);
    if (level !== undefined) {
      seen.add(level);
    }
  }
  if (seen.size === 0) {
    return [];
  }
  seen.add("default");
  return keepReasoningOrder(seen);
}

/** Disk-cache parser: missing / empty field stays empty (boolean-only legacy). */
export function parseStoredReasoningLevels(value: unknown): readonly ReasoningLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    const level = parseReasoningLevel(item);
    if (level !== undefined) {
      seen.add(level);
    }
  }
  if (seen.size === 0) {
    return [];
  }
  seen.add("default");
  return keepReasoningOrder(seen);
}

/**
 * Source A `/v1/models`: empty when the vendor sent no reasoning signal so the
 * importer can omit and let the backend default. Nonempty lists are ordered
 * allow-lists (default kept; none when not mandatory).
 */
export function fetchedReasoningLevels(item: unknown): readonly ReasoningLevel[] {
  const facts = vendorReasoningFacts(item);
  const hasMapped = facts.effortTokens.some((token) => mapVendorEffort(token) !== undefined);
  if (!hasMapped && !facts.hasToggle && facts.reasoning !== true) {
    return [];
  }
  return buildReasoningAllowList(facts);
}

/**
 * Import mapping (PRD FR-53): catalog effort list wins when nonempty; else
 * Source A; else boolean-only catalog fallback; else omit.
 */
export function resolveImportReasoningLevels(input: {
  catalogLevels?: readonly string[] | undefined;
  catalogReasoning?: boolean | undefined;
  fetchedLevels?: readonly string[] | undefined;
}): readonly string[] | undefined {
  if (input.catalogLevels !== undefined && input.catalogLevels.length > 0) {
    return input.catalogLevels;
  }
  if (input.fetchedLevels !== undefined && input.fetchedLevels.length > 0) {
    return input.fetchedLevels;
  }
  if (input.catalogReasoning === false) {
    return ["default"];
  }
  if (input.catalogReasoning === true) {
    return LEGACY_CATALOG_REASONING;
  }
  return undefined;
}
