import { HIGH_AGENT_MAX_TOKENS, type Catalog, type DesiredState, type Model, type Provider } from "../domain/types.ts";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODALITIES,
  DEFAULT_REASONING_LEVELS,
  makeModel,
} from "../domain/model.ts";
import { parseModelId, parseModelSlug } from "../supervisor/plan.ts";
import { type BoxPaths } from "../supervisor/paths.ts";
import { parseProviderId, parseSecretBytes } from "../supervisor/secrets.ts";
import { customBoxFromCatalog, officialBox, parseUpstreamOrigin, slugify } from "./argv.ts";

export type ModelLimitsInput = {
  readonly contextTokens?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly reasoningLevels?: unknown;
  readonly modalities?: unknown;
  readonly activeReasoning?: unknown;
};

export type UiCommand =
  | { readonly kind: "official" }
  | {
      readonly kind: "upsert-provider";
      readonly name: string;
      readonly origin: string;
      readonly modelSlug: string;
      readonly secret: string;
      readonly contextTokens?: unknown;
      readonly maxOutputTokens?: unknown;
      readonly reasoningLevels?: unknown;
      readonly modalities?: unknown;
    }
  | {
      readonly kind: "upsert-model";
      readonly providerId: string;
      readonly slug: string;
      readonly contextTokens?: unknown;
      readonly maxOutputTokens?: unknown;
      readonly reasoningLevels?: unknown;
      readonly modalities?: unknown;
      readonly activeReasoning?: unknown;
    }
  | { readonly kind: "use-model"; readonly modelId: string; readonly reasoning?: unknown }
  | { readonly kind: "remove-provider"; readonly providerId: string }
  | { readonly kind: "set-secret"; readonly providerId: string; readonly secret: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function limitsFrom(input: Record<string, unknown>): ModelLimitsInput {
  const next: {
    contextTokens?: unknown;
    maxOutputTokens?: unknown;
    reasoningLevels?: unknown;
    modalities?: unknown;
    activeReasoning?: unknown;
  } = {};
  if (input.contextTokens !== undefined) {
    next.contextTokens = input.contextTokens;
  }
  if (input.maxOutputTokens !== undefined) {
    next.maxOutputTokens = input.maxOutputTokens;
  }
  if (input.reasoningLevels !== undefined) {
    next.reasoningLevels = input.reasoningLevels;
  }
  if (input.modalities !== undefined) {
    next.modalities = input.modalities;
  }
  if (input.activeReasoning !== undefined) {
    next.activeReasoning = input.activeReasoning;
  }
  return next;
}

export function parseUiCommand(input: unknown): UiCommand {
  if (!isRecord(input) || typeof input.kind !== "string") {
    throw new Error("OpenBot: UI save needs a kind");
  }
  if (input.kind === "official") {
    return { kind: "official" };
  }
  if (input.kind === "custom" || input.kind === "upsert-provider") {
    if (typeof input.name !== "string" || typeof input.origin !== "string" || typeof input.modelSlug !== "string") {
      throw new Error("OpenBot: upsert-provider needs name, origin, and modelSlug");
    }
    if (typeof input.secret !== "string") {
      throw new Error("OpenBot: upsert-provider needs a secret in the POST body");
    }
    return {
      kind: "upsert-provider",
      name: input.name,
      origin: input.origin,
      modelSlug: input.modelSlug,
      secret: input.secret,
      ...limitsFrom(input),
    };
  }
  if (input.kind === "upsert-model") {
    if (typeof input.providerId !== "string" || typeof input.slug !== "string") {
      throw new Error("OpenBot: upsert-model needs providerId and slug");
    }
    return {
      kind: "upsert-model",
      providerId: input.providerId,
      slug: input.slug,
      ...limitsFrom(input),
    };
  }
  if (input.kind === "use-model") {
    if (typeof input.modelId !== "string") {
      throw new Error("OpenBot: use-model needs modelId");
    }
    if (input.reasoning === undefined) {
      return { kind: "use-model", modelId: input.modelId };
    }
    return { kind: "use-model", modelId: input.modelId, reasoning: input.reasoning };
  }
  if (input.kind === "remove-provider") {
    if (typeof input.providerId !== "string") {
      throw new Error("OpenBot: remove-provider needs providerId");
    }
    return { kind: "remove-provider", providerId: input.providerId };
  }
  if (input.kind === "set-secret") {
    if (typeof input.providerId !== "string" || typeof input.secret !== "string") {
      throw new Error("OpenBot: set-secret needs providerId and secret");
    }
    return { kind: "set-secret", providerId: input.providerId, secret: input.secret };
  }
  throw new Error("OpenBot: unknown UI command");
}

function emptyCatalog(): Catalog {
  return { providers: [], models: [], bindings: [] };
}

function withWildcard(catalog: Catalog, modelId: Model["id"]): Catalog {
  return {
    ...catalog,
    bindings: [{ conversation: { kind: "wildcard" }, modelId }],
  };
}

function upsertProviderRow(catalog: Catalog, provider: Provider): Catalog {
  const rest = catalog.providers.filter((row) => row.id !== provider.id);
  return { ...catalog, providers: [...rest, provider] };
}

function upsertModelRow(catalog: Catalog, model: Model): Catalog {
  const rest = catalog.models.filter((row) => row.id !== model.id);
  const models = [...rest, model];
  const hasWildcard = catalog.bindings.some((row) => row.conversation.kind === "wildcard");
  if (hasWildcard) {
    return { ...catalog, models };
  }
  return withWildcard({ ...catalog, models }, model.id);
}

function modelFromLimits(input: {
  id: Model["id"];
  providerId: Model["providerId"];
  slug: Model["slug"];
  existing: Model | undefined;
  limits: ModelLimitsInput;
}): Model {
  const existing = input.existing;
  return makeModel({
    id: input.id,
    providerId: input.providerId,
    slug: input.slug,
    contextTokens: input.limits.contextTokens ?? existing?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
    maxOutputTokens: input.limits.maxOutputTokens ?? existing?.maxOutputTokens ?? HIGH_AGENT_MAX_TOKENS,
    reasoningLevels: input.limits.reasoningLevels ?? existing?.reasoningLevels ?? DEFAULT_REASONING_LEVELS,
    modalities: input.limits.modalities ?? existing?.modalities ?? DEFAULT_MODALITIES,
    activeReasoning: input.limits.activeReasoning ?? existing?.activeReasoning ?? "none",
    parameters: existing?.parameters ?? [],
  });
}

export type UiSave = {
  readonly desired: DesiredState;
  readonly secret?: { providerId: ReturnType<typeof parseProviderId>; bytes: ReturnType<typeof parseSecretBytes> };
  readonly catalogWrite?: Catalog;
};

export function applyUiCommand(input: {
  command: UiCommand;
  catalog: Catalog;
  paths: BoxPaths;
}): UiSave {
  const { command, catalog, paths } = input;
  if (command.kind === "official") {
    return { desired: officialBox(paths) };
  }
  if (command.kind === "set-secret") {
    const providerId = parseProviderId(command.providerId);
    if (!catalog.providers.some((row) => row.id === providerId)) {
      throw new Error("OpenBot: unknown provider");
    }
    if (catalog.models.length === 0) {
      throw new Error("OpenBot: add a model before using custom chat");
    }
    return {
      desired: customBoxFromCatalog({ paths, catalog }),
      secret: { providerId, bytes: parseSecretBytes(command.secret) },
    };
  }
  if (command.kind === "upsert-provider") {
    const providerId = parseProviderId(slugify(command.name));
    const origin = parseUpstreamOrigin(command.origin);
    const slug = parseModelSlug(command.modelSlug);
    const modelId = parseModelId(`${providerId}:${command.modelSlug}`);
    const existing = catalog.models.find((row) => row.id === modelId);
    const next = upsertModelRow(
      upsertProviderRow(catalog, {
        id: providerId,
        name: command.name,
        origin,
        maxTokensDefault: HIGH_AGENT_MAX_TOKENS,
        mapFile: "provider-maps.cjs",
      }),
      modelFromLimits({
        id: modelId,
        providerId,
        slug,
        existing,
        limits: command,
      }),
    );
    return {
      desired: customBoxFromCatalog({ paths, catalog: withWildcard(next, modelId) }),
      secret: { providerId, bytes: parseSecretBytes(command.secret) },
    };
  }
  if (command.kind === "upsert-model") {
    const providerId = parseProviderId(command.providerId);
    if (!catalog.providers.some((row) => row.id === providerId)) {
      throw new Error("OpenBot: unknown provider");
    }
    const slug = parseModelSlug(command.slug);
    const modelId = parseModelId(`${providerId}:${command.slug}`);
    const existing = catalog.models.find((row) => row.id === modelId);
    const next = upsertModelRow(
      catalog,
      modelFromLimits({
        id: modelId,
        providerId,
        slug,
        existing,
        limits: command,
      }),
    );
    return { desired: customBoxFromCatalog({ paths, catalog: next }) };
  }
  if (command.kind === "use-model") {
    const modelId = parseModelId(command.modelId);
    const model = catalog.models.find((row) => row.id === modelId);
    if (!model) {
      throw new Error("OpenBot: unknown model");
    }
    const nextModel = makeModel({
      id: model.id,
      providerId: model.providerId,
      slug: model.slug,
      contextTokens: model.contextTokens,
      maxOutputTokens: model.maxOutputTokens,
      reasoningLevels: model.reasoningLevels,
      modalities: model.modalities,
      activeReasoning: command.reasoning ?? model.activeReasoning,
      parameters: model.parameters,
    });
    const next = upsertModelRow(catalog, nextModel);
    return { desired: customBoxFromCatalog({ paths, catalog: withWildcard(next, modelId) }) };
  }
  const providerId = parseProviderId(command.providerId);
  const providers = catalog.providers.filter((row) => row.id !== providerId);
  const models = catalog.models.filter((row) => row.providerId !== providerId);
  if (providers.length === 0 || models.length === 0) {
    return { desired: officialBox(paths), catalogWrite: emptyCatalog() };
  }
  const active = catalog.bindings.find((row) => row.conversation.kind === "wildcard");
  const stillBound = active && models.some((row) => row.id === active.modelId);
  const fallback = models[0];
  if (fallback === undefined) {
    return { desired: officialBox(paths), catalogWrite: emptyCatalog() };
  }
  const next: Catalog = {
    providers,
    models,
    bindings: [{ conversation: { kind: "wildcard" }, modelId: stillBound && active ? active.modelId : fallback.id }],
  };
  return { desired: customBoxFromCatalog({ paths, catalog: next }) };
}

export function parseUiProviderSave(
  input: unknown,
  paths: BoxPaths,
  catalog: Catalog = emptyCatalog(),
): UiSave {
  return applyUiCommand({ command: parseUiCommand(input), catalog, paths });
}
