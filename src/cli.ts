#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseInstallCommand, officialBox, customBoxFromProvider, slugify } from "./parse/argv.ts";
import { observe } from "./supervisor/observe.ts";
import { dryRunWrap, reconcile } from "./supervisor/reconcile.ts";
import { nodeFs, nodeProcs } from "./supervisor/procs.ts";
import { loadSecrets, parseProviderId, saveSecrets, upsertSecret } from "./supervisor/secrets.ts";
import { catalogFromPlanJson } from "./supervisor/plan.ts";
import { readExposeFile } from "./supervisor/tunnel.ts";
import { censusHost } from "./host/census.ts";
import { loopbackExpose, type Expose } from "./domain/types.ts";
import { type SupervisorDeps } from "./supervisor/observe.ts";
import { customBoxFromCatalog } from "./parse/argv.ts";
import { printResult, printStatus } from "./cli/print.ts";

function depsFrom(paths: SupervisorDeps["paths"]): SupervisorDeps {
  return { paths, fs: nodeFs(), procs: nodeProcs() };
}

/** y/yes enable a quick tunnel. Empty, EOF, and anything else stay loopback. */
export function exposeFromTunnelAnswer(raw: string | undefined): Expose {
  if (raw === undefined) {
    return loopbackExpose();
  }
  const token = raw.trim().toLowerCase();
  if (token === "y" || token === "yes") {
    return { kind: "cloudflare-quick" };
  }
  return loopbackExpose();
}

function readTtyLine(): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync("/dev/tty", "r");
  } catch {
    return undefined;
  }
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(256);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) {
        break;
      }
      const slice = buf.subarray(0, n);
      const nl = slice.indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(Buffer.from(slice.subarray(0, nl)));
        return Buffer.concat(chunks).toString("utf8").replace(/\r$/u, "");
      }
      chunks.push(Buffer.from(slice));
    }
    if (chunks.length === 0) {
      return undefined;
    }
    return Buffer.concat(chunks).toString("utf8").replace(/\r$/u, "");
  } finally {
    fs.closeSync(fd);
  }
}

export const TUNNEL_PROMPT =
  "Open this control page from a phone?\n" +
  "Cloudflare Tunnel prints a public URL and a QR code.\n" +
  "Anyone with that URL can open the page. Keys stay on this Computer.\n" +
  "\n" +
  "  Type y then press Enter    phone URL + QR\n" +
  "  Press Enter                this Computer only\n" +
  "\n" +
  "Use Cloudflare Tunnel? [y/N] ";

function askTunnel(): Expose {
  if (!process.stderr.isTTY) {
    return loopbackExpose();
  }
  process.stderr.write(TUNNEL_PROMPT);
  const answer = readTtyLine();
  if (answer === undefined) {
    process.stderr.write("\nNo answer from this terminal. Staying on this Computer. Later: openbot tunnel on\n");
    return loopbackExpose();
  }
  return exposeFromTunnelAnswer(answer);
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseInstallCommand({ argv, env: process.env, metaUrl: import.meta.url });
  const deps = depsFrom(parsed.paths);
  const savedExpose = readExposeFile(deps.fs, deps.paths.expose);

  if (parsed.command.kind === "census-only") {
    const source = deps.fs.read(deps.paths.hostMain);
    if (source === undefined) {
      console.error(`OpenBot: missing host file ${deps.paths.hostMain}`);
      return 1;
    }
    const snapshot = await observe(deps);
    console.log(JSON.stringify({ census: censusHost(source), snapshot }, null, 2));
    console.error("OpenBot: census is not proof that wrap would succeed. Use --dry-run.");
    return 0;
  }

  if (parsed.command.kind === "dry-run") {
    const result = dryRunWrap(deps);
    console.log(JSON.stringify(result, null, 2));
    return result.kind === "refused" || (result.kind === "proof" && result.proof.kind === "refused") ? 1 : 0;
  }

  if (parsed.command.kind === "status") {
    const snapshot = await observe(deps);
    printStatus(snapshot, parsed.json);
    return 0;
  }

  if (parsed.command.kind === "tunnel") {
    if (parsed.command.action === "status") {
      const snapshot = await observe(deps);
      printStatus(snapshot, parsed.json);
      return 0;
    }
    const expose: Expose = parsed.command.action === "on" ? { kind: "cloudflare-quick" } : loopbackExpose();
    const mode = deps.fs.read(deps.paths.mode)?.trim();
    const catalog = catalogFromPlanJson(deps.fs.read(deps.paths.plan));
    const desired =
      mode === "custom" && catalog.models.length > 0
        ? customBoxFromCatalog({ paths: parsed.paths, catalog, expose })
        : officialBox(parsed.paths, expose);
    const result = await reconcile(desired, deps);
    printResult(result, parsed.json);
    return result.kind === "ok" ? 0 : 1;
  }

  if (parsed.command.kind === "official") {
    const result = await reconcile(officialBox(parsed.paths, savedExpose), deps);
    printResult(result, parsed.json);
    return result.kind === "ok" ? 0 : 1;
  }

  const custom = parsed.command.kind === "install" ? parsed.command.custom : undefined;
  const flagged = parsed.command.kind === "install" ? parsed.command.expose : loopbackExpose();
  const specified = parsed.command.kind === "install" && parsed.command.exposeSpecified;
  const expose = specified ? flagged : askTunnel();

  if (custom) {
    const box = customBoxFromProvider({
      paths: parsed.paths,
      origin: custom.origin,
      name: custom.name,
      modelSlug: custom.modelSlug,
      expose,
    });
    const result = await reconcile(box, deps);
    if (result.kind === "ok") {
      const store = loadSecrets(deps.fs, parsed.paths.secrets);
      saveSecrets(
        deps.fs,
        parsed.paths.secrets,
        upsertSecret(store, parseProviderId(slugify(custom.name)), custom.secret),
      );
    }
    printResult(result, parsed.json);
    return result.kind === "ok" ? 0 : 1;
  }

  const result = await reconcile(officialBox(parsed.paths, expose), deps);
  printResult(result, parsed.json);
  return result.kind === "ok" ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      process.exit(1);
    },
  );
}

export { main };
