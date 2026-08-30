import {
  hopBaseUrl,
  LOOPBACK_HOP,
  type Binding,
  type Catalog,
  type CustomBox,
  type ModelId,
  type ModelSlug,
} from "../domain/types.ts";

export type CompiledAgent = {
  readonly modelId: ModelSlug;
  readonly providerId: string;
};

export type CompiledCustomPlan = {
  readonly kind: "custom";
  readonly hop: { readonly host: "127.0.0.1"; readonly port: 18790 };
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
  const agents: { [key: string]: CompiledAgent } = {};
  for (const binding of box.catalog.bindings) {
    const model = box.catalog.models.find((row) => row.id === binding.modelId);
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
    catalog: box.catalog,
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
  return catalog as Catalog;
}
