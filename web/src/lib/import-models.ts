import { getModelCatalog } from "../api/client";
import type { CatalogLookupModel, FetchedModel } from "../api/types";

/**
 * Build the `upsert-model` limits payload for an imported model, preferring
 * Source B catalog metadata over the provider's own (Source A) `/v1/models`
 * response — the latter often ships no context/output/modality/reasoning data.
 *
 * Mapping rules (documented in docs/rebuild/PRD.md §8.1 / FR-53):
 * - contextTokens / maxOutputTokens: catalog value when present, else the
 *   fetch value, else omitted (the backend fills its default).
 * - modalities: the catalog's non-empty list, else the fetch list, else omitted.
 * - reasoningLevels:
 *   1. catalog `reasoningLevels` nonempty → use that ordered allow-list
 *   2. else fetched `reasoningLevels` nonempty → use Source A
 *   3. else catalog `reasoning === false` → `["default"]`
 *   4. else catalog `reasoning === true` → legacy `["default","none","high"]`
 *      (boolean-only / old cache)
 *   5. else omit (backend defaults)
 *   A boolean-only catalog must not wipe nonempty Source A levels.
 */

const LEGACY_CATALOG_REASONING: readonly string[] = ["default", "none", "high"];

function positive(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function importReasoningLevels(
  fetched: FetchedModel,
  catalog?: CatalogLookupModel,
): readonly string[] | undefined {
  if (catalog?.reasoningLevels !== undefined && catalog.reasoningLevels.length > 0) {
    return catalog.reasoningLevels;
  }
  if (fetched.reasoningLevels?.length) {
    return fetched.reasoningLevels;
  }
  if (catalog && catalog.reasoning === false) {
    return ["default"];
  }
  if (catalog && catalog.reasoning === true) {
    return LEGACY_CATALOG_REASONING;
  }
  return undefined;
}

export function modelImportFields(
  fetched: FetchedModel,
  catalog?: CatalogLookupModel,
): {
  slug: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  reasoningLevels?: readonly string[];
  modalities?: readonly string[];
} {
  const contextTokens = positive(catalog?.contextLength) ?? positive(fetched.contextLength);
  const maxOutputTokens = positive(catalog?.maxOutputTokens) ?? positive(fetched.maxOutputTokens);
  const reasoningLevels = importReasoningLevels(fetched, catalog);

  const modalities = catalog?.modalities?.length
    ? catalog.modalities
    : fetched.modalities?.length
      ? fetched.modalities
      : undefined;

  return {
    slug: fetched.id,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(reasoningLevels ? { reasoningLevels } : {}),
    ...(modalities ? { modalities } : {}),
  };
}

/** Source B catalog enrichment for a fetched model list (badge + auto-fill metadata). */
export type CatalogEnrichment = {
  matched: Set<string>;
  lookup: Map<string, CatalogLookupModel>;
};

export async function enrichCatalogModels(fetched: FetchedModel[]): Promise<CatalogEnrichment> {
  const matched = new Set<string>();
  const lookup = new Map<string, CatalogLookupModel>();
  const batch = fetched.slice(0, 40);
  await Promise.all(
    batch.map(async (m) => {
      try {
        const c = await getModelCatalog(m.id);
        if (c.lookup?.found && c.lookup.model) {
          matched.add(m.id);
          lookup.set(m.id, c.lookup.model);
        }
      } catch {
        /* skip */
      }
    }),
  );
  return { matched, lookup };
}
