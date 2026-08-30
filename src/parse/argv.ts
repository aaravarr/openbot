import { fileURLToPath } from "node:url";
import {
  HIGH_AGENT_MAX_TOKENS,
  LOOPBACK,
  LOOPBACK_HOP,
  OPENBOT_MARKER,
  SERVICE_PORT,
  type Catalog,
  type CustomBox,
  type OfficialBox,
  type UpstreamOrigin,
} from "../domain/types.ts";
import { parseModelId, parseModelSlug } from "../supervisor/plan.ts";
import { boxPathsFrom, parseAbsPath, type BoxPaths } from "../supervisor/paths.ts";
import { parseProviderId, parseSecretBytes } from "../supervisor/secrets.ts";

export type CliCommand =
  | { readonly kind: "status" }
  | { readonly kind: "census-only" }
  | { readonly kind: "dry-run" }
  | { readonly kind: "official" }
  | {
      readonly kind: "install";
      readonly custom?: {
        readonly origin: UpstreamOrigin;
        readonly name: string;
        readonly modelSlug: string;
        readonly secret: ReturnType<typeof parseSecretBytes>;
      };
    };

export type ParsedCli = {
  readonly command: CliCommand;
  readonly paths: BoxPaths;
};

/** `import.meta.url` already names the file, so one `..` is the package root. */
export function repoRootFromMeta(metaUrl: string): string {
  return fileURLToPath(new URL("..", metaUrl)).replace(/\/$/u, "");
}

function takeFlag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at < 0) {
    return undefined;
  }
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`OpenBot: ${name} needs a value`);
  }
  return value;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

export function parseInstallCommand(input: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  repoRoot?: string;
  metaUrl?: string;
}): ParsedCli {
  const argv = [...input.argv];
  if (hasFlag(argv, "--api-key") || hasFlag(argv, "--secret") || hasFlag(argv, "-k")) {
    throw new Error("OpenBot: do not put an API key on the command line; use OPENBOT_API_KEY");
  }

  const repoRoot = input.repoRoot ?? (input.metaUrl ? repoRootFromMeta(input.metaUrl) : process.cwd());
  const paths = boxPathsFrom({
    repoRoot,
    hostMain: takeFlag(argv, "--host-main"),
    sandData: takeFlag(argv, "--sand-data"),
  });

  if (hasFlag(argv, "--census-only") && hasFlag(argv, "--dry-run")) {
    throw new Error("OpenBot: --census-only is observe; --dry-run is proveWrap; pick one");
  }
  if (hasFlag(argv, "--census-only")) {
    return { command: { kind: "census-only" }, paths };
  }
  if (hasFlag(argv, "--dry-run")) {
    return { command: { kind: "dry-run" }, paths };
  }
  if (argv.includes("official") || argv.includes("disable")) {
    return { command: { kind: "official" }, paths };
  }
  if (argv.includes("status")) {
    return { command: { kind: "status" }, paths };
  }

  const origin = takeFlag(argv, "--origin");
  const model = takeFlag(argv, "--model");
  const name = takeFlag(argv, "--name") ?? "default";
  if (origin || model) {
    if (!origin || !model) {
      throw new Error("OpenBot: --origin and --model are required together");
    }
    const key = input.env.OPENBOT_API_KEY;
    if (!key) {
      throw new Error("OpenBot: set OPENBOT_API_KEY in the environment, not on the argv");
    }
    return {
      command: {
        kind: "install",
        custom: {
          origin: parseUpstreamOrigin(origin),
          name,
          modelSlug: model,
          secret: parseSecretBytes(key),
        },
      },
      paths,
    };
  }

  return { command: { kind: "install" }, paths };
}

export function parseUpstreamOrigin(raw: string): UpstreamOrigin {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OpenBot: origin is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OpenBot: origin must be http(s)");
  }
  return raw.replace(/\/+$/u, "") as UpstreamOrigin;
}

export function officialBox(paths: BoxPaths): OfficialBox {
  return {
    kind: "official",
    wrap: { kind: "stock" },
    hopListen: { kind: "stop-owned" },
    uiListen: { kind: "loopback", host: LOOPBACK, port: SERVICE_PORT },
    secretsPath: paths.secrets,
  };
}

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "");
  return slug || "provider";
}

export function customBoxFromCatalog(input: { paths: BoxPaths; catalog: Catalog }): CustomBox {
  return {
    kind: "custom",
    wrap: { kind: "marked", marker: OPENBOT_MARKER },
    hopListen: { kind: "adopt-or-start", host: LOOPBACK, port: SERVICE_PORT },
    uiListen: { kind: "loopback", host: LOOPBACK, port: SERVICE_PORT },
    secretsPath: input.paths.secrets,
    hop: LOOPBACK_HOP,
    catalog: input.catalog,
  };
}

export function customBoxFromProvider(input: {
  paths: BoxPaths;
  origin: UpstreamOrigin;
  name: string;
  modelSlug: string;
}): CustomBox {
  const providerId = parseProviderId(slugify(input.name));
  const modelId = parseModelId(`${providerId}:${input.modelSlug}`);
  const slug = parseModelSlug(input.modelSlug);
  return customBoxFromCatalog({
    paths: input.paths,
    catalog: {
      providers: [
        {
          id: providerId,
          name: input.name,
          origin: input.origin,
          maxTokensDefault: HIGH_AGENT_MAX_TOKENS,
          mapFile: "provider-maps.cjs",
        },
      ],
      models: [
        {
          id: modelId,
          providerId,
          slug,
          parameters: [],
        },
      ],
      bindings: [{ conversation: { kind: "wildcard" }, modelId }],
    },
  });
}

export function parseDisableCommand(input: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  repoRoot?: string;
}): ParsedCli {
  return parseInstallCommand({ ...input, argv: ["official", ...input.argv] });
}

export { parseAbsPath };
