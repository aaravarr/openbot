import { fileURLToPath } from "node:url";
import { makeModel } from "../domain/model.ts";
import {
  HIGH_AGENT_MAX_TOKENS,
  LOOPBACK,
  LOOPBACK_HOP,
  OPENBOT_MARKER,
  SERVICE_PORT,
  loopbackExpose,
  type Catalog,
  type CustomBox,
  type Expose,
  type OfficialBox,
  type UpstreamOrigin,
} from "../domain/types.ts";
import { parseModelId, parseModelSlug } from "../supervisor/plan.ts";
import { boxPathsFrom, parseAbsPath, type BoxPaths } from "../supervisor/paths.ts";
import { parseProviderId, parseSecretBytes } from "../supervisor/secrets.ts";
import { clampIntervalMinutes, DEFAULT_GUARD_INTERVAL_MINUTES } from "../supervisor/guard-daemon.ts";
import {
  DEFERRED_BOUNCE_BUSY_QUIET_MS,
  DEFERRED_BOUNCE_MAX_WAIT_MS,
  DEFERRED_BOUNCE_STOP_QUIET_MS,
} from "../supervisor/reconcile.ts";

export type CliCommand =
  | { readonly kind: "qrcode"; readonly text: string; readonly out: string }
  | { readonly kind: "status" }
  | { readonly kind: "census-only" }
  | { readonly kind: "dry-run" }
  | { readonly kind: "official" }
  | { readonly kind: "guard"; readonly action: "once" | "daemon" | "stop"; readonly intervalMinutes: number }
  | { readonly kind: "tunnel"; readonly action: "on" | "off" | "status" }
  | {
      readonly kind: "finalize-host";
      /** One attempt, then exit (the alias --bot-finalize implies this). */
      readonly once: boolean;
      readonly force: boolean;
      readonly stopQuietMs: number;
      readonly busyQuietMs: number;
      readonly maxWaitMs: number;
      readonly pollMs: number;
    }
  | {
      readonly kind: "install";
      readonly custom?: {
        readonly origin: UpstreamOrigin;
        readonly name: string;
        readonly modelSlug: string;
        readonly secret: ReturnType<typeof parseSecretBytes>;
      };
      readonly expose: Expose;
      readonly exposeSpecified: boolean;
      readonly json: boolean;
      /** Bot self-upgrade: arm the host bounce instead of killing the caller. */
      readonly deferHostBounce: boolean;
    };

export type ParsedCli = {
  readonly command: CliCommand;
  readonly paths: BoxPaths;
  readonly json: boolean;
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

export function parseExposeToken(raw: string | undefined): Expose | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const token = raw.trim().toLowerCase();
  if (token === "off" || token === "loopback" || token === "no" || token === "false") {
    return { kind: "loopback" };
  }
  if (token === "cloudflare" || token === "cloudflare-quick" || token === "cf" || token === "on") {
    return { kind: "cloudflare-quick" };
  }
  if (token === "tailscale") {
    throw new Error("OpenBot: Tailscale is not in this release. Use --tunnel cloudflare or --tunnel off.");
  }
  throw new Error("OpenBot: --tunnel is cloudflare or off");
}

/** `--interval` minutes for the guard daemon: default 5, clamped to 1-60. */
export function clampGuardInterval(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_GUARD_INTERVAL_MINUTES;
  }
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) {
    throw new Error("OpenBot: --interval needs a number of minutes");
  }
  return clampIntervalMinutes(value);
}

/** Milliseconds flag with a default; junk is rejected instead of guessed. */
export function parseMsFlag(argv: readonly string[], name: string, fallback: number): number {
  const at = argv.indexOf(name);
  if (at < 0) {
    return fallback;
  }
  const raw = argv[at + 1];
  const value = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(value) || value < 0) {
    throw new Error(`OpenBot: ${name} needs a number of milliseconds`);
  }
  return Math.floor(value);
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

  const isQrcode = argv.includes("qrcode");
  const repoRoot = isQrcode
    ? "/"
    : input.repoRoot ?? (input.metaUrl ? repoRootFromMeta(input.metaUrl) : process.cwd());
  const paths = boxPathsFrom({
    repoRoot,
    hostMain: isQrcode ? "/tmp/openbot-host" : takeFlag(argv, "--host-main"),
    sandData: isQrcode ? "/tmp/openbot-sand-data" : takeFlag(argv, "--sand-data"),
  });
  const json = hasFlag(argv, "--json");

  if (argv.includes("qrcode")) {
    const text = takeFlag(argv, "--text");
    const out = takeFlag(argv, "--out");
    if (!text || !out) {
      throw new Error("OpenBot: qrcode needs --text and --out");
    }
    return { command: { kind: "qrcode", text, out }, paths, json };
  }

  if (hasFlag(argv, "--census-only") && hasFlag(argv, "--dry-run")) {
    throw new Error("OpenBot: --census-only is observe; --dry-run is proveWrap; pick one");
  }
  if (hasFlag(argv, "--census-only")) {
    return { command: { kind: "census-only" }, paths, json };
  }
  if (hasFlag(argv, "--dry-run")) {
    return { command: { kind: "dry-run" }, paths, json };
  }
  if (argv.includes("official") || argv.includes("disable")) {
    return { command: { kind: "official" }, paths, json };
  }
  if (argv.includes("status")) {
    return { command: { kind: "status" }, paths, json };
  }
  // Applies an armed deferred host bounce (the marker a bot-mode upgrade
  // writes instead of SIGTERMing the caller's host). --bot-finalize is the
  // single-attempt alias the bot can run by hand.
  if (argv.includes("finalize-host") || hasFlag(argv, "--bot-finalize")) {
    const botAlias = hasFlag(argv, "--bot-finalize");
    return {
      command: {
        kind: "finalize-host",
        once: hasFlag(argv, "--once") || botAlias,
        force: hasFlag(argv, "--force"),
        stopQuietMs: parseMsFlag(argv, "--wait-idle-ms", DEFERRED_BOUNCE_STOP_QUIET_MS),
        busyQuietMs: parseMsFlag(argv, "--busy-wait-ms", DEFERRED_BOUNCE_BUSY_QUIET_MS),
        maxWaitMs: parseMsFlag(argv, "--max-wait-ms", DEFERRED_BOUNCE_MAX_WAIT_MS),
        pollMs: parseMsFlag(argv, "--poll-ms", 5000),
      },
      paths,
      json,
    };
  }
  if (argv.includes("guard")) {
    const intervalMinutes = clampGuardInterval(takeFlag(argv, "--interval"));
    if (hasFlag(argv, "--stop")) {
      return { command: { kind: "guard", action: "stop", intervalMinutes }, paths, json };
    }
    if (hasFlag(argv, "--daemon")) {
      return { command: { kind: "guard", action: "daemon", intervalMinutes }, paths, json };
    }
    return { command: { kind: "guard", action: "once", intervalMinutes }, paths, json };
  }
  const tunnelAt = argv.indexOf("tunnel");
  if (tunnelAt >= 0) {
    const action = argv[tunnelAt + 1];
    if (action === "on" || action === "off" || action === "status") {
      return { command: { kind: "tunnel", action }, paths, json };
    }
    throw new Error("OpenBot: tunnel is on, off, or status");
  }

  const origin = takeFlag(argv, "--origin");
  const model = takeFlag(argv, "--model");
  const name = takeFlag(argv, "--name") ?? "default";
  const tunnelFlag = takeFlag(argv, "--tunnel");
  const deferHostBounce = hasFlag(argv, "--defer-host-bounce") || input.env.OPENBOT_DEFER_HOST_BOUNCE === "1";
  const exposeSpecified = Boolean(tunnelFlag || input.env.OPENBOT_TUNNEL);
  const expose =
    parseExposeToken(tunnelFlag) ?? parseExposeToken(input.env.OPENBOT_TUNNEL) ?? loopbackExpose();
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
        expose,
        exposeSpecified,
        json,
        deferHostBounce,
      },
      paths,
      json,
    };
  }

  return { command: { kind: "install", expose, exposeSpecified, json, deferHostBounce }, paths, json };
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

export function officialBox(paths: BoxPaths, expose: Expose = loopbackExpose()): OfficialBox {
  return {
    kind: "official",
    wrap: { kind: "stock" },
    hopListen: { kind: "stop-owned" },
    uiListen: { kind: "loopback", host: LOOPBACK, port: SERVICE_PORT },
    secretsPath: paths.secrets,
    expose,
  };
}

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "");
  return slug || "provider";
}

export function customBoxFromCatalog(input: {
  paths: BoxPaths;
  catalog: Catalog;
  expose?: Expose | undefined;
}): CustomBox {
  return {
    kind: "custom",
    wrap: { kind: "marked", marker: OPENBOT_MARKER },
    hopListen: { kind: "adopt-or-start", host: LOOPBACK, port: SERVICE_PORT },
    uiListen: { kind: "loopback", host: LOOPBACK, port: SERVICE_PORT },
    secretsPath: input.paths.secrets,
    hop: LOOPBACK_HOP,
    catalog: input.catalog,
    expose: input.expose ?? loopbackExpose(),
  };
}

export function customBoxFromProvider(input: {
  paths: BoxPaths;
  origin: UpstreamOrigin;
  name: string;
  modelSlug: string;
  expose?: Expose | undefined;
}): CustomBox {
  const providerId = parseProviderId(slugify(input.name));
  const modelId = parseModelId(`${providerId}:${input.modelSlug}`);
  const slug = parseModelSlug(input.modelSlug);
  return customBoxFromCatalog({
    paths: input.paths,
    expose: input.expose ?? loopbackExpose(),
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
      models: [makeModel({ id: modelId, providerId, slug })],
      bindings: [{ conversation: { kind: "wildcard" }, modelId }],
    },
  });
}

/**
 * Re-running install must follow openbot-mode, not wipe Chat back to official.
 * A missing mode file may still infer custom from a catalog (same as observe).
 */
export function boxFromSavedMode(input: {
  paths: BoxPaths;
  mode: string | undefined;
  catalog: Catalog;
  expose: Expose;
}): OfficialBox | CustomBox {
  const mode = input.mode?.trim();
  const hasModels = input.catalog.models.length > 0;
  if (mode === "custom" && hasModels) {
    return customBoxFromCatalog({ paths: input.paths, catalog: input.catalog, expose: input.expose });
  }
  if (mode === "official") {
    return officialBox(input.paths, input.expose);
  }
  if (hasModels) {
    return customBoxFromCatalog({ paths: input.paths, catalog: input.catalog, expose: input.expose });
  }
  return officialBox(input.paths, input.expose);
}

export function parseDisableCommand(input: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  repoRoot?: string;
}): ParsedCli {
  return parseInstallCommand({ ...input, argv: ["official", ...input.argv] });
}

export { parseAbsPath };
