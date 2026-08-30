import { parseSecretBytes } from "../supervisor/secrets.ts";
import { type BoxPaths } from "../supervisor/paths.ts";
import { customBoxFromProvider, officialBox, parseUpstreamOrigin } from "./argv.ts";
import { type DesiredState } from "../domain/types.ts";

export type UiSaveInput =
  | { readonly kind: "official" }
  | {
      readonly kind: "custom";
      readonly name: string;
      readonly origin: string;
      readonly modelSlug: string;
      readonly secret: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseUiProviderSave(input: unknown, paths: BoxPaths): {
  desired: DesiredState;
  secret?: { providerName: string; bytes: ReturnType<typeof parseSecretBytes> };
} {
  if (!isRecord(input) || typeof input.kind !== "string") {
    throw new Error("OpenBot: UI save needs a kind");
  }
  if (input.kind === "official") {
    return { desired: officialBox(paths) };
  }
  if (input.kind !== "custom") {
    throw new Error("OpenBot: UI save kind is official or custom");
  }
  if (typeof input.name !== "string" || typeof input.origin !== "string" || typeof input.modelSlug !== "string") {
    throw new Error("OpenBot: custom save needs name, origin, and modelSlug");
  }
  if (typeof input.secret !== "string") {
    throw new Error("OpenBot: custom save needs a secret in the POST body, not in a binding");
  }
  const origin = parseUpstreamOrigin(input.origin);
  const desired = customBoxFromProvider({
    paths,
    origin,
    name: input.name,
    modelSlug: input.modelSlug,
  });
  return {
    desired,
    secret: { providerName: input.name, bytes: parseSecretBytes(input.secret) },
  };
}
