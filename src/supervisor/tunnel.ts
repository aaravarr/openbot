import { randomUUID } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import {
  LOOPBACK,
  SERVICE_PORT,
  type AbsPath,
  type Expose,
  type OwnedPid,
  type TunnelObserved,
} from "../domain/types.ts";
import { parseOwnedPid, type FsDeps, type ProcDeps } from "./procs.ts";
import { parseAbsPath, type BoxPaths } from "./paths.ts";

export type TunnelDeps = {
  readonly paths: BoxPaths;
  readonly fs: FsDeps;
  readonly procs: ProcDeps;
};

export type TunnelNet = {
  download(url: string, dest: AbsPath): Promise<void>;
};

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/giu;
const WAIT_MS = 12000;
/**
 * The cloudflared log is history now, not scratch space: it is appended to
 * across restarts and only cut when it grows past this. One previous
 * generation is kept beside it, so a diagnosis still has the old tail.
 */
export const TUNNEL_LOG_MAX_BYTES = 4 * 1024 * 1024;

/** Why a quick tunnel had to be started instead of adopted. */
export type TunnelStartReason = "no-cache" | "pid-dead" | "cache-unreadable";

export type TunnelEvent = {
  readonly type: "tunnel.start" | "tunnel.rotate";
  readonly severity: "INFO" | "WARN";
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
};

export function parseQuickTunnelUrl(log: string): string | undefined {
  const matches = [...log.matchAll(QUICK_URL)];
  const last = matches[matches.length - 1];
  return last?.[0];
}

export function readExposeFile(fsDeps: FsDeps, path: AbsPath): Expose {
  const raw = fsDeps.read(path)?.trim().toLowerCase();
  if (raw === "cloudflare-quick" || raw === "cloudflare") {
    return { kind: "cloudflare-quick" };
  }
  return { kind: "loopback" };
}

export function exposeFilePresent(fsDeps: FsDeps, path: AbsPath): boolean {
  const raw = fsDeps.read(path);
  return typeof raw === "string" && raw.trim() !== "";
}

export function writeExposeFile(fsDeps: FsDeps, path: AbsPath, expose: Expose): void {
  fsDeps.write(path, `${expose.kind}\n`, 0o644);
}

export function internalControlUrl(): string {
  return `http://${LOOPBACK}:${String(SERVICE_PORT)}`;
}

/**
 * The address recorded in the cache, whatever the pidfile says.
 *
 * `readTunnelCache` answers "is a tunnel live" and drops this the moment the
 * process is gone; the restart path still needs the address it is replacing,
 * or the history row would silently lose it.
 */
export function readCachedTunnelUrl(deps: TunnelDeps): string | undefined {
  const raw = deps.fs.read(deps.paths.tunnelCache);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { kind?: unknown }).kind === "cloudflare-quick" &&
      typeof (parsed as { url?: unknown }).url === "string"
    ) {
      return (parsed as { url: string }).url;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function readTunnelCache(deps: TunnelDeps): TunnelObserved {
  const pid = deps.procs.readPidFile(deps.paths.tunnelPid);
  if (pid === undefined || !deps.procs.pidAlive(pid)) {
    return { kind: "off" };
  }
  const url = readCachedTunnelUrl(deps);
  if (url === undefined) {
    return { kind: "off" };
  }
  return {
    kind: "cloudflare-quick",
    url,
    internal: internalControlUrl(),
    pid: parseOwnedPid(pid),
  };
}

/**
 * Why the cached tunnel cannot be adopted. Read before the pidfile and the
 * cache are overwritten: it is what the history row records as the cause.
 */
export function tunnelStartReason(deps: TunnelDeps): TunnelStartReason {
  const pid = deps.procs.readPidFile(deps.paths.tunnelPid);
  if (pid === undefined) {
    return "no-cache";
  }
  if (!deps.procs.pidAlive(pid)) {
    return "pid-dead";
  }
  // A live cloudflared whose cache we cannot read: nothing records which
  // hostname it booked, so it is replaced rather than adopted.
  return "cache-unreadable";
}

function writeTunnelCache(deps: TunnelDeps, url: string, pid: number): void {
  deps.fs.write(
    deps.paths.tunnelCache,
    `${JSON.stringify(
      {
        kind: "cloudflare-quick",
        url,
        internal: internalControlUrl(),
        pid,
      },
      null,
      2,
    )}\n`,
    0o644,
  );
}

function clearTunnelCache(deps: TunnelDeps): void {
  deps.fs.remove(deps.paths.tunnelCache);
  deps.fs.remove(deps.paths.tunnelPid);
}

export function stopOwnedTunnel(deps: TunnelDeps): void {
  const pid = deps.procs.readPidFile(deps.paths.tunnelPid);
  if (pid !== undefined && deps.procs.pidAlive(pid)) {
    deps.procs.stop(parseOwnedPid(pid));
  }
  clearTunnelCache(deps);
}

/**
 * Bound the cloudflared log without erasing it: past the cap the current file
 * becomes `openbot-tunnel.log.1` (one generation kept) and the next start
 * writes a fresh one. Below the cap nothing is touched, so the tunnel history
 * survives restarts -- which is exactly what the old unconditional truncate
 * destroyed.
 */
function rotateTunnelLogIfLarge(deps: TunnelDeps): void {
  const existing = deps.fs.read(deps.paths.tunnelLog);
  if (existing === undefined || Buffer.byteLength(existing, "utf8") <= TUNNEL_LOG_MAX_BYTES) {
    return;
  }
  const previous = parseAbsPath(`${deps.paths.tunnelLog}.1`);
  const rename = deps.fs.rename;
  try {
    deps.fs.remove(previous);
    if (rename !== undefined) {
      rename.call(deps.fs, deps.paths.tunnelLog, previous);
      return;
    }
  } catch {
    /* an unrotatable log is still better than a lost one: fall through */
  }
  deps.fs.remove(deps.paths.tunnelLog);
}

/**
 * Append text to a file that other writers append to as well (a running
 * cloudflared's log, the events channel the service writes). `FsDeps.append`
 * keeps the write atomic against them; the read-then-write fallback is for
 * test doubles that do not provide it. Throws: callers decide what is
 * best-effort.
 */
function appendText(deps: TunnelDeps, path: AbsPath, body: string): void {
  const append = deps.fs.append;
  if (append !== undefined) {
    append.call(deps.fs, path, body, 0o644);
    return;
  }
  deps.fs.write(path, `${deps.fs.read(path) ?? ""}${body}`, 0o644);
}

/** Append one OpenBot marker line to the cloudflared log. Never throws. */
function appendTunnelLogLine(deps: TunnelDeps, line: string): void {
  try {
    appendText(deps, deps.paths.tunnelLog, line);
  } catch {
    /* the tunnel log is best-effort */
  }
}

/**
 * Append one row to the events channel (`openbot-events.jsonl`), the same file
 * and shape `payload/request-log.cjs` `appendEvent` writes: an events row must
 * carry an id for the reader, and this must land whether or not request
 * recording is on. Written straight through `deps.fs` because a CLI reconcile
 * (`openbot tunnel on`) runs without the control service.
 */
export function appendTunnelEvent(deps: TunnelDeps, entry: TunnelEvent): void {
  try {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      at: new Date().toISOString(),
      type: entry.type,
      severity: entry.severity,
      message: entry.message,
    };
    if (entry.metadata !== undefined) {
      row.metadata = entry.metadata;
    }
    appendText(deps, deps.paths.eventsLog, `${JSON.stringify(row)}\n`);
  } catch {
    /* events are best-effort: a history write must never fail a reconcile */
  }
}

function cloudflaredAsset(): string {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  if (process.platform === "darwin") {
    return `cloudflared-darwin-${arch}`;
  }
  return `cloudflared-linux-${arch}`;
}

export function cloudflaredDownloadUrl(): string {
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/${cloudflaredAsset()}`;
}

export async function downloadHttps(url: string, dest: AbsPath): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const follow = (href: string, hops: number): void => {
      if (hops > 6) {
        reject(new Error("OpenBot: too many redirects fetching cloudflared"));
        return;
      }
      https
        .get(href, { headers: { "User-Agent": "openbot" } }, (res) => {
          const code = res.statusCode ?? 0;
          const location = res.headers.location;
          if (code >= 300 && code < 400 && typeof location === "string") {
            res.resume();
            follow(new URL(location, href).href, hops + 1);
            return;
          }
          if (code !== 200) {
            res.resume();
            reject(new Error(`OpenBot: cloudflared download failed (${String(code)})`));
            return;
          }
          const out = fs.createWriteStream(dest, { mode: 0o755 });
          res.pipe(out);
          out.on("finish", () => {
            out.close();
            try {
              fs.chmodSync(dest, 0o755);
            } catch {
              /* already executable */
            }
            resolve();
          });
          out.on("error", reject);
        })
        .on("error", reject);
    };
    follow(url, 0);
  });
}

export async function ensureCloudflared(deps: TunnelDeps, net: TunnelNet = { download: downloadHttps }): Promise<AbsPath> {
  if (deps.fs.exists(deps.paths.tunnelBin)) {
    return deps.paths.tunnelBin;
  }
  const dir = deps.paths.tunnelBin.replace(/\/[^/]+$/u, "") as AbsPath;
  deps.fs.mkdirp(dir);
  await net.download(cloudflaredDownloadUrl(), deps.paths.tunnelBin);
  return deps.paths.tunnelBin;
}

/**
 * Wait for the URL of the cloudflared we just spawned.
 *
 * `fromOffset` is the log length right after this start's marker line: the log
 * now keeps every previous tunnel's output, so an unqualified "last URL in the
 * log" would happily return the hostname of the tunnel we are replacing.
 */
async function waitForUrl(deps: TunnelDeps, budgetMs: number, fromOffset: number): Promise<string | undefined> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const url = parseQuickTunnelUrl((deps.fs.read(deps.paths.tunnelLog) ?? "").slice(fromOffset));
    if (url) {
      return url;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return parseQuickTunnelUrl((deps.fs.read(deps.paths.tunnelLog) ?? "").slice(fromOffset));
}

/**
 * What this start is replacing, captured before anything is cleared. Passed in
 * by a caller that has already removed the stale cache (`reconcileExpose` does
 * that before restarting), and read from disk otherwise.
 */
export type TunnelReplacement = {
  readonly previousUrl: string | undefined;
  readonly reason: TunnelStartReason;
};

/**
 * Start one cloudflared quick tunnel, wait for its public URL, and cache it.
 *
 * Exported for the tunnel babysitter (src/supervisor/tunnel-watch.ts), which
 * restarts the tunnel when the process behind the cached URL has died. Every
 * other caller goes through reconcileExpose.
 */
export async function startQuickTunnel(
  deps: TunnelDeps,
  net: TunnelNet,
  replaced?: TunnelReplacement,
): Promise<TunnelObserved> {
  // Everything the history needs is read before the first write: the cache
  // still holds the address being replaced, and the pidfile still names the
  // process that owned it.
  const previousUrl = replaced === undefined ? readCachedTunnelUrl(deps) : replaced.previousUrl;
  const reason = replaced === undefined ? tunnelStartReason(deps) : replaced.reason;
  const bin = await ensureCloudflared(deps, net);
  deps.fs.mkdirp(deps.paths.sandData);
  rotateTunnelLogIfLarge(deps);
  appendTunnelLogLine(
    deps,
    `--- openbot: starting cloudflared (${reason})${previousUrl !== undefined ? `, replacing ${previousUrl}` : ""} at ${
      new Date().toISOString()
    } ---\n`,
  );
  const fromOffset = (deps.fs.read(deps.paths.tunnelLog) ?? "").length;
  let pid: OwnedPid;
  try {
    pid = deps.procs.start({
      command: bin,
      argv: ["tunnel", "--no-autoupdate", "--url", internalControlUrl()],
      env: { ...process.env },
      log: deps.paths.tunnelLog,
      pidFile: deps.paths.tunnelPid,
    });
  } catch (err) {
    if (!deps.fs.exists(bin)) {
      throw new Error(`cloudflared not found at ${bin}`);
    }
    throw err;
  }
  const url = await waitForUrl(deps, WAIT_MS, fromOffset);
  // A replacement is a rotation even when the old address could not be read
  // back (a corrupt cache): something was serving before, and it is not any
  // more. Only a start with nothing behind it is a plain start.
  const rotated = reason !== "no-cache";
  const describe = (newUrl: string | undefined): TunnelEvent => {
    const metadata: Record<string, unknown> = { reason, pid };
    if (newUrl !== undefined) {
      metadata.url = newUrl;
    }
    if (previousUrl !== undefined) {
      metadata.previousUrl = previousUrl;
    }
    const next = newUrl ?? "no URL published";
    if (!rotated) {
      return {
        type: "tunnel.start",
        severity: "INFO",
        message: `Cloudflare Tunnel started: ${next} (pid ${String(pid)}).`,
        metadata,
      };
    }
    const change =
      previousUrl !== undefined
        ? `${previousUrl} -> ${next}`
        : `${next} (the previous hostname was not recoverable)`;
    return {
      type: "tunnel.rotate",
      severity: "WARN",
      message: `Cloudflare Tunnel URL changed (${reason}): ${change}.`,
      metadata,
    };
  };
  if (!url) {
    deps.procs.stop(pid);
    clearTunnelCache(deps);
    appendTunnelEvent(deps, describe(undefined));
    return {
      kind: "error",
      message: "Cloudflare Tunnel started but no public URL appeared. Check openbot-tunnel.log.",
    };
  }
  writeTunnelCache(deps, url, pid);
  appendTunnelLogLine(deps, `--- openbot: cloudflared pid ${String(pid)} published ${url} ---\n`);
  appendTunnelEvent(deps, describe(url));
  return {
    kind: "cloudflare-quick",
    url,
    internal: internalControlUrl(),
    pid,
  };
}

/** True when the expose file already records this expose, alias included. */
function exposeFileMatches(deps: TunnelDeps, expose: Expose): boolean {
  const raw = deps.fs.read(deps.paths.expose)?.trim().toLowerCase();
  if (expose.kind === "cloudflare-quick") {
    return raw === "cloudflare-quick" || raw === "cloudflare";
  }
  return raw === "loopback";
}

/**
 * Make the box match `expose`.
 *
 * A quick-tunnel hostname is bound to the cloudflared process that booked it:
 * while that pid is alive the URL is valid, and cloudflared re-books it across
 * its own reconnects. The cached entry is therefore the whole liveness test --
 * `readTunnelCache` already answers off when the pid is gone or the cache is
 * missing or corrupt.
 *
 * Nothing here probes the public URL any more. A single failed HTTPS probe
 * used to mean "dead", so every reconcile -- UI save, guard repair, CLI
 * install/tunnel, and install.sh's install-then-`tunnel on` pair five seconds
 * apart, whose brand-new hostname has no DNS yet -- could stop a healthy
 * cloudflared and burn a fresh hostname. The user saw that as a link that
 * changes and does not open. A new URL now happens only when the pid is really
 * dead (or the cache is unusable), or when the user explicitly turns the
 * tunnel off and on.
 */
export async function reconcileExpose(
  expose: Expose,
  deps: TunnelDeps,
  net?: TunnelNet,
): Promise<TunnelObserved> {
  if (!exposeFileMatches(deps, expose)) {
    writeExposeFile(deps.fs, deps.paths.expose, expose);
  }
  if (expose.kind === "loopback") {
    stopOwnedTunnel(deps);
    return { kind: "off" };
  }
  const cached = readTunnelCache(deps);
  if (cached.kind === "cloudflare-quick") {
    return cached;
  }
  // Nothing usable to adopt: the recorded process is dead, or its cache was
  // lost while it kept running. Clear first so the restart cannot leave an
  // orphan cloudflared behind holding an untracked hostname -- and capture what
  // is being replaced first, because clearing is exactly what forgets it.
  const previousUrl = readCachedTunnelUrl(deps);
  const reason = tunnelStartReason(deps);
  stopOwnedTunnel(deps);
  const transport: TunnelNet = net ?? { download: downloadHttps };
  try {
    return await startQuickTunnel(deps, transport, { previousUrl, reason });
  } catch (err) {
    stopOwnedTunnel(deps);
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Cloudflare Tunnel could not start",
    };
  }
}
