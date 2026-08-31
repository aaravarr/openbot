import {
  hopBaseUrl,
  LOOPBACK_HOP,
  SERVICE_PORT,
  type Binding,
  type Catalog,
  type CustomBox,
  type Model,
  type ModelId,
  type ModelSlug,
} from "../domain/types.ts";
import { normalizeModel } from "../domain/model.ts";

export type CompiledAgent = {
  readonly modelId: ModelSlug;
  readonly providerId: string;
};

export type CompiledCustomPlan = {
  readonly kind: "custom";
  readonly hop: { readonly host: "127.0.0.1"; readonly port: typeof SERVICE_PORT };
  readonly hopBaseUrl: ReturnType<typeof hopBaseUrl>;
  readonly agents: { readonly [key: string]: CompiledAgent };
  readonly catalog: Catalog;
};

export function conversationKey(binding: Binding): string {
  if (binding.conversation.kind === "wildcard") {
    return "*";
  }
  return binding.conversation.id;
}

export function compileCustomPlan(box: CustomBox): CompiledCustomPlan {
  const catalog = normalizeCatalog(box.catalog);
  const agents: { [key: string]: CompiledAgent } = {};
  for (const binding of catalog.bindings) {
    const model = catalog.models.find((row) => row.id === binding.modelId);
    if (!model) {
      throw new Error("OpenBot: binding model is not in the catalog");
    }
    agents[conversationKey(binding)] = { modelId: model.slug, providerId: model.providerId };
  }
  return {
    kind: "custom",
    hop: LOOPBACK_HOP,
    hopBaseUrl: hopBaseUrl(LOOPBACK_HOP),
    agents,
    catalog,
  };
}

export function parseModelId(raw: string): ModelId {
  if (!raw.trim()) {
    throw new Error("OpenBot: model id is empty");
  }
  return raw as ModelId;
}

export function parseModelSlug(raw: string): ModelSlug {
  if (!raw.trim() || raw.includes(" ")) {
    throw new Error("OpenBot: model slug is empty");
  }
  return raw as ModelSlug;
}

export function planToJson(plan: CompiledCustomPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeCatalog(catalog: Catalog): Catalog {
  const models: Model[] = [];
  for (const row of catalog.models) {
    const model = normalizeModel(row);
    if (model) {
      models.push(model);
    }
  }
  return { providers: catalog.providers, models, bindings: catalog.bindings };
}

export function catalogFromPlanJson(raw: string | undefined): Catalog {
  if (raw === undefined) {
    return { providers: [], models: [], bindings: [] };
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.kind !== "custom" || !isRecord(parsed.catalog)) {
    return { providers: [], models: [], bindings: [] };
  }
  const catalog = parsed.catalog;
  if (!Array.isArray(catalog.providers) || !Array.isArray(catalog.models) || !Array.isArray(catalog.bindings)) {
    return { providers: [], models: [], bindings: [] };
  }
  const models: Model[] = [];
  for (const row of catalog.models) {
    const model = normalizeModel(row);
    if (model) {
      models.push(model);
    }
  }
  return {
    providers: catalog.providers as Catalog["providers"],
    models,
    bindings: catalog.bindings as Catalog["bindings"],
  };
}
