import fs from "node:fs";
import https from "node:https";
import { LOOPBACK, SERVICE_PORT, type AbsPath, type Expose, type TunnelObserved } from "../domain/types.ts";
import { parseOwnedPid, type FsDeps, type ProcDeps } from "./procs.ts";
import { type BoxPaths } from "./paths.ts";

export type TunnelDeps = {
  readonly paths: BoxPaths;
  readonly fs: FsDeps;
  readonly procs: ProcDeps;
};

export type TunnelNet = {
  download(url: string, dest: AbsPath): Promise<void>;
};

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu;
const WAIT_MS = 12000;

export function parseQuickTunnelUrl(log: string): string | undefined {
  const match = log.match(QUICK_URL);
  return match?.[0];
}

export function readExposeFile(fsDeps: FsDeps, path: AbsPath): Expose {
  const raw = fsDeps.read(path)?.trim().toLowerCase();
  if (raw === "cloudflare-quick" || raw === "cloudflare") {
    return { kind: "cloudflare-quick" };
  }
  return { kind: "loopback" };
}

export function writeExposeFile(fsDeps: FsDeps, path: AbsPath, expose: Expose): void {
  fsDeps.write(path, `${expose.kind}\n`, 0o644);
}

export function internalControlUrl(): string {
  return `http://${LOOPBACK}:${String(SERVICE_PORT)}`;
}

export function readTunnelCache(deps: TunnelDeps): TunnelObserved {
  const pid = deps.procs.readPidFile(deps.paths.tunnelPid);
  if (pid === undefined || !deps.procs.pidAlive(pid)) {
    return { kind: "off" };
  }
  const raw = deps.fs.read(deps.paths.tunnelCache);
  if (!raw) {
    return { kind: "off" };
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
      return {
        kind: "cloudflare-quick",
        url: (parsed as { url: string }).url,
        internal: internalControlUrl(),
        pid: parseOwnedPid(pid),
      };
    }
  } catch {
    return { kind: "off" };
  }
  return { kind: "off" };
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

async function waitForUrl(deps: TunnelDeps, budgetMs: number): Promise<string | undefined> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const log = deps.fs.read(deps.paths.tunnelLog) ?? "";
    const url = parseQuickTunnelUrl(log);
    if (url) {
      return url;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return parseQuickTunnelUrl(deps.fs.read(deps.paths.tunnelLog) ?? "");
}

export async function reconcileExpose(
  expose: Expose,
  deps: TunnelDeps,
  net?: TunnelNet,
): Promise<TunnelObserved> {
  writeExposeFile(deps.fs, deps.paths.expose, expose);
  if (expose.kind === "loopback") {
    stopOwnedTunnel(deps);
    return { kind: "off" };
  }
  const cached = readTunnelCache(deps);
  if (cached.kind === "cloudflare-quick") {
    return cached;
  }
  try {
    const bin = await ensureCloudflared(deps, net ?? { download: downloadHttps });
    deps.fs.mkdirp(deps.paths.sandData);
    const pid = deps.procs.start({
      command: bin,
      argv: ["tunnel", "--no-autoupdate", "--url", internalControlUrl()],
      env: { ...process.env },
      log: deps.paths.tunnelLog,
      pidFile: deps.paths.tunnelPid,
    });
    const url = await waitForUrl(deps, WAIT_MS);
    if (!url) {
      deps.procs.stop(pid);
      clearTunnelCache(deps);
      return {
        kind: "error",
        message: "Cloudflare Tunnel started but no public URL appeared. Check openbot-tunnel.log.",
      };
    }
    writeTunnelCache(deps, url, pid);
    return {
      kind: "cloudflare-quick",
      url,
      internal: internalControlUrl(),
      pid,
    };
  } catch (err) {
    stopOwnedTunnel(deps);
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Cloudflare Tunnel could not start",
    };
  }
}
