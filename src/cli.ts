#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseInstallCommand, officialBox, customBoxFromProvider, slugify } from "./parse/argv.ts";
import { observe } from "./supervisor/observe.ts";
import { dryRunWrap, reconcile } from "./supervisor/reconcile.ts";
import { nodeFs, nodeProcs } from "./supervisor/procs.ts";
import { loadSecrets, parseProviderId, saveSecrets, upsertSecret } from "./supervisor/secrets.ts";
import { censusHost } from "./host/census.ts";
import { LOOPBACK, SERVICE_PORT } from "./domain/types.ts";
import { type SupervisorDeps } from "./supervisor/observe.ts";

function depsFrom(paths: SupervisorDeps["paths"]): SupervisorDeps {
  return { paths, fs: nodeFs(), procs: nodeProcs() };
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseInstallCommand({ argv, env: process.env, metaUrl: import.meta.url });
  const deps = depsFrom(parsed.paths);

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
    console.log(JSON.stringify(snapshot, null, 2));
    return 0;
  }

  if (parsed.command.kind === "official") {
    const result = await reconcile(officialBox(parsed.paths), deps);
    printResult(result);
    return result.kind === "ok" ? 0 : 1;
  }

  const custom = parsed.command.custom;
  if (custom) {
    const box = customBoxFromProvider({
      paths: parsed.paths,
      origin: custom.origin,
      name: custom.name,
      modelSlug: custom.modelSlug,
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
    printResult(result);
    return result.kind === "ok" ? 0 : 1;
  }

  const result = await reconcile(officialBox(parsed.paths), deps);
  printResult(result);
  if (result.kind === "ok") {
    console.log(`OpenBot UI: http://${LOOPBACK}:${String(SERVICE_PORT)}`);
    console.log("Open that page on this Computer and pick a model.");
  }
  return result.kind === "ok" ? 0 : 1;
}

function printResult(result: Awaited<ReturnType<typeof reconcile>>): void {
  if (result.kind === "ok") {
    console.log(JSON.stringify({ ok: true, wrapBytesChanged: result.wrapBytesChanged, snapshot: result.snapshot }, null, 2));
    return;
  }
  console.error(JSON.stringify(result, null, 2));
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
