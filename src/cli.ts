#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  parseInstallCommand,
  officialBox,
  customBoxFromProvider,
  slugify,
  boxFromSavedMode,
} from "./parse/argv.ts";
import { observe } from "./supervisor/observe.ts";
import {
  applyDeferredHostBounce,
  dryRunWrap,
  reconcile,
  type DeferredBounceOutcome,
} from "./supervisor/reconcile.ts";
import { guardCustom } from "./supervisor/guard.ts";
import { runGuardDaemon, stopGuardDaemon } from "./supervisor/guard-daemon.ts";
import { nodeFs, nodeProcs } from "./supervisor/procs.ts";
import { loadSecrets, parseProviderId, saveSecrets, upsertSecret } from "./supervisor/secrets.ts";
import { catalogFromPlanJson } from "./supervisor/plan.ts";
import { exposeFilePresent, readExposeFile } from "./supervisor/tunnel.ts";
import { censusHost } from "./host/census.ts";
import { loopbackExpose, type Expose } from "./domain/types.ts";
import { type SupervisorDeps } from "./supervisor/observe.ts";
import { printResult, printStatus } from "./cli/print.ts";
import { writeQrPng } from "./qrcode-png.ts";

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

/** Flag wins. Later installs keep the saved expose so an update does not stop Cloudflare. */
export function resolveInstallExpose(input: {
  specified: boolean;
  flagged: Expose;
  saved: Expose;
  savedPresent: boolean;
  asked: Expose;
}): Expose {
  if (input.specified) {
    return input.flagged;
  }
  if (input.savedPresent) {
    return input.saved;
  }
  return input.asked;
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

function boxFromDisk(deps: SupervisorDeps, expose: Expose) {
  const mode = deps.fs.read(deps.paths.mode);
  const catalog = catalogFromPlanJson(deps.fs.read(deps.paths.plan));
  return boxFromSavedMode({ paths: deps.paths, mode, catalog, expose });
}

export type FinalizeHostOpts = {
  /** One attempt, then exit — the detached worker passes none, the alias does. */
  readonly once: boolean;
  readonly force: boolean;
  readonly stopQuietMs: number;
  readonly busyQuietMs: number;
  readonly maxWaitMs: number;
  readonly pollMs: number;
  readonly source?: string | undefined;
  /** Injected clock and sleeper for tests. */
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
};

/**
 * Apply an armed deferred host bounce, waiting for the host to go idle.
 *
 * The marker is the single source of truth and `applyDeferredHostBounce` is
 * idempotent, so running two finalizers (the detached one plus a guard tick)
 * is harmless. The loop is bounded by `maxWaitMs`; past that bound the
 * applier force-applies, and if the host still has a request in flight the
 * loop exits and the guard daemon retries on its next tick.
 */
export async function runFinalizeHost(
  deps: SupervisorDeps,
  opts: FinalizeHostOpts,
): Promise<DeferredBounceOutcome> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedMs = now();
  for (;;) {
    const outcome = applyDeferredHostBounce(deps, { source: opts.source ?? "cli:finalize-host" }, {
      nowMs: now(),
      stopQuietMs: opts.stopQuietMs,
      busyQuietMs: opts.busyQuietMs,
      maxWaitMs: opts.maxWaitMs,
      force: opts.force,
    });
    if (outcome.kind !== "idle-pending" || opts.once || now() - startedMs >= opts.maxWaitMs) {
      return outcome;
    }
    await sleep(opts.pollMs);
  }
}

export function printFinalizeOutcome(outcome: DeferredBounceOutcome, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(outcome));
    return;
  }
  if (outcome.kind === "applied") {
    const why = outcome.forced ? "the max wait passed" : "the host is idle";
    console.log(`OpenBot: deferred host bounce applied because ${why} (pid ${outcome.pids.join(", ")}).`);
    return;
  }
  if (outcome.kind === "skipped") {
    console.log(`OpenBot: no deferred host bounce to apply (${outcome.reason}).`);
    return;
  }
  console.log(`OpenBot: deferred host bounce is still waiting (${outcome.reason}).`);
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseInstallCommand({ argv, env: process.env, metaUrl: import.meta.url });
  const deps = depsFrom(parsed.paths);
  const savedExpose = readExposeFile(deps.fs, deps.paths.expose);

  if (parsed.command.kind === "qrcode") {
    writeQrPng(parsed.command.text, parsed.command.out);
    console.log(parsed.command.out);
    return 0;
  }

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

  if (parsed.command.kind === "finalize-host") {
    const outcome = await runFinalizeHost(deps, {
      once: parsed.command.once,
      force: parsed.command.force,
      stopQuietMs: parsed.command.stopQuietMs,
      busyQuietMs: parsed.command.busyQuietMs,
      maxWaitMs: parsed.command.maxWaitMs,
      pollMs: parsed.command.pollMs,
      source: "cli:finalize-host",
    });
    printFinalizeOutcome(outcome, parsed.json);
    return 0;
  }

  if (parsed.command.kind === "guard") {
    if (parsed.command.action === "stop") {
      const stopped = stopGuardDaemon(deps);
      console.log(stopped ? "OpenBot: guard daemon stopped." : "OpenBot: guard daemon is not running.");
      return 0;
    }
    if (parsed.command.action === "daemon") {
      const signal = new AbortController();
      const onSignal = (): void => {
        signal.abort();
      };
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
      try {
        const outcome = await runGuardDaemon(deps, {
          intervalMinutes: parsed.command.intervalMinutes,
          signal: signal.signal,
          hopHealth: process.env.OPENBOT_GUARD_HOP_HEALTH !== "0",
          ...(Number(process.env.OPENBOT_GUARD_HOP_FAILURE_THRESHOLD || "2")
            ? { hopFailureThreshold: Number(process.env.OPENBOT_GUARD_HOP_FAILURE_THRESHOLD) }
            : {}),
        });
        if (outcome.kind === "already-running") {
          console.error(`OpenBot: guard daemon already running (pid ${outcome.pid}).`);
        }
        return 0;
      } finally {
        process.removeListener("SIGTERM", onSignal);
        process.removeListener("SIGINT", onSignal);
      }
    }
    const result = await guardCustom(deps);
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (parsed.command.kind === "tunnel") {
    if (parsed.command.action === "status") {
      const snapshot = await observe(deps);
      printStatus(snapshot, parsed.json);
      return 0;
    }
    const expose: Expose = parsed.command.action === "on" ? { kind: "cloudflare-quick" } : loopbackExpose();
    const result = await reconcile(boxFromDisk(deps, expose), deps, { reloadService: true, source: "cli:tunnel" });
    printResult(result, parsed.json);
    return result.kind === "ok" ? 0 : 1;
  }

  if (parsed.command.kind === "official") {
    const result = await reconcile(officialBox(parsed.paths, savedExpose), deps, {
      reloadService: true,
      source: "cli:official",
    });
    printResult(result, parsed.json);
    return result.kind === "ok" ? 0 : 1;
  }

  const custom = parsed.command.kind === "install" ? parsed.command.custom : undefined;
  const deferHostBounce = parsed.command.kind === "install" && parsed.command.deferHostBounce;
  const flagged = parsed.command.kind === "install" ? parsed.command.expose : loopbackExpose();
  const specified = parsed.command.kind === "install" && parsed.command.exposeSpecified;
  const savedPresent = exposeFilePresent(deps.fs, deps.paths.expose);
  const expose = resolveInstallExpose({
    specified,
    flagged,
    saved: savedExpose,
    savedPresent,
    asked: savedPresent || specified ? loopbackExpose() : askTunnel(),
  });

  if (custom) {
    const box = customBoxFromProvider({
      paths: parsed.paths,
      origin: custom.origin,
      name: custom.name,
      modelSlug: custom.modelSlug,
      expose,
    });
    const result = await reconcile(box, deps, {
      reloadService: true,
      source: "cli:install",
      ...(deferHostBounce ? { deferHostBounce: true } : {}),
    });
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

  const result = await reconcile(boxFromDisk(deps, expose), deps, {
    reloadService: true,
    source: "cli:install",
    ...(deferHostBounce ? { deferHostBounce: true } : {}),
  });
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
