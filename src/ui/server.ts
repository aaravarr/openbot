import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { LOOPBACK, SERVICE_PORT, type Catalog, type Snapshot, type TunnelObserved } from "../domain/types.ts";
import { catalogAfterSave, parseUiProviderSave } from "../parse/ui.ts";
import { renderQrAscii } from "../qrcode.ts";
import { boxPathsFrom } from "../supervisor/paths.ts";
import { catalogFromPlanJson } from "../supervisor/plan.ts";
import { observe, type SupervisorDeps } from "../supervisor/observe.ts";
import { nodeFs, nodeProcs } from "../supervisor/procs.ts";
import { reconcile } from "../supervisor/reconcile.ts";
import { loadSecrets, saveSecrets, upsertSecret } from "../supervisor/secrets.ts";
import { readExposeFile } from "../supervisor/tunnel.ts";

type LogSettings = {
  loggingEnabled: boolean;
  logBodies: boolean;
  logBodiesOnError: boolean;
  logRetentionDays: number;
  maxBodyCaptureBytes: number;
  maxRecords: number;
};

type LogList = {
  items: unknown[];
  total: number;
  page: number;
  pageSize: number;
};

const require = createRequire(import.meta.url);
const hop = require("../../payload/hop-handler.cjs") as {
  handleHopRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
};
const requestLog = require("../../payload/request-log.cjs") as {
  loadSettings: () => LogSettings;
  saveSettings: (input: unknown) => LogSettings;
  listRequests: (query: Record<string, unknown>) => LogList;
  getRequest: (id: string) => unknown;
  clearRequests: () => void;
};

const repoRoot = process.env.OPENBOT_REPO ?? fileURLToPath(new URL("../..", import.meta.url));
const uiDir = path.join(repoRoot, "ui");
const host = process.env.OPENBOT_UI_HOST ?? LOOPBACK;
const port = Number(process.env.OPENBOT_UI_PORT ?? String(SERVICE_PORT));

let saveChain: Promise<void> = Promise.resolve();

function enqueueSave<T>(work: () => Promise<T>): Promise<T> {
  const run = saveChain.then(work, work);
  saveChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function paths() {
  return boxPathsFrom({
    repoRoot,
    hostMain: process.env.OPENBOT_HOST_MAIN,
    sandData: process.env.OPENBOT_SAND_DATA,
  });
}

function deps(): SupervisorDeps {
  return { paths: paths(), fs: nodeFs(), procs: nodeProcs() };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function send(res: http.ServerResponse, status: number, body: string | Buffer, type: string): void {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Length": String(buf.length),
  });
  res.end(buf);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function wrapMode(raw: string | undefined): "official" | "custom" {
  return raw?.trim() === "custom" ? "custom" : "official";
}

function tunnelForUi(tunnel: TunnelObserved): TunnelObserved & { qr?: string } {
  if (tunnel.kind !== "cloudflare-quick") {
    return tunnel;
  }
  try {
    return { ...tunnel, qr: renderQrAscii(tunnel.url) };
  } catch {
    return tunnel;
  }
}

function snapshotForUi(snapshot: Snapshot): Snapshot & { tunnel: TunnelObserved & { qr?: string } } {
  return { ...snapshot, tunnel: tunnelForUi(snapshot.tunnel) };
}

function logSettings(): LogSettings {
  return requestLog.loadSettings();
}

function publicState(current: SupervisorDeps, catalog?: Catalog) {
  const saved = catalog ?? catalogFromPlanJson(current.fs.read(current.paths.plan));
  const store = loadSecrets(current.fs, current.paths.secrets);
  const keyedProviders = Object.keys(store.providers);
  const active = saved.bindings.find((row) => row.conversation.kind === "wildcard");
  return {
    providers: saved.providers,
    models: saved.models,
    keyedProviders,
    activeModelId: active?.modelId ?? null,
    logSettings: logSettings(),
  };
}

function parseLogsQuery(url: URL): Record<string, unknown> {
  const q = url.searchParams.get("q") ?? "";
  const model = url.searchParams.get("model") ?? "";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const okRaw = url.searchParams.get("ok");
  const page = Number(url.searchParams.get("page"));
  const pageSize = Number(url.searchParams.get("pageSize"));
  const query: Record<string, unknown> = {};
  if (q.trim()) {
    query.q = q;
  }
  if (model.trim()) {
    query.model = model;
  }
  if (from.trim()) {
    query.from = from;
  }
  if (to.trim()) {
    query.to = to;
  }
  if (okRaw === "true") {
    query.ok = true;
  } else if (okRaw === "false") {
    query.ok = false;
  }
  if (Number.isInteger(page)) {
    query.page = page;
  }
  if (Number.isInteger(pageSize)) {
    query.pageSize = pageSize;
  }
  return query;
}

function logIdFromPath(pathname: string): string | undefined {
  const prefix = "/api/logs/";
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes("/")) {
    return undefined;
  }
  try {
    return decodeURIComponent(rest);
  } catch {
    return undefined;
  }
}

async function handleLogsApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/api/logs/settings") {
    sendJson(res, 200, logSettings());
    return true;
  }
  if (req.method === "PUT" && url.pathname === "/api/logs/settings") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req)) as unknown;
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return true;
    }
    try {
      sendJson(res, 200, requestLog.saveSettings(parsed));
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid log settings";
      sendJson(res, 400, { error: message });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/logs/clear") {
    requestLog.clearRequests();
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/logs") {
    sendJson(res, 200, requestLog.listRequests(parseLogsQuery(url)));
    return true;
  }
  if (req.method === "GET") {
    const id = logIdFromPath(url.pathname);
    if (id) {
      const detail = requestLog.getRequest(id);
      if (detail === null || detail === undefined) {
        sendJson(res, 404, { error: "not found" });
        return true;
      }
      sendJson(res, 200, detail);
      return true;
    }
  }
  return false;
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const current = deps();
  if (req.method === "GET" && (url.pathname === "/api/snapshot" || url.pathname === "/api/state")) {
    const snapshot = await observe(current);
    sendJson(res, 200, { snapshot: snapshotForUi(snapshot), ...publicState(current) });
    return;
  }
  if (await handleLogsApi(req, res, url)) {
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/save") {
    await enqueueSave(async () => {
      const parsedBody: unknown = JSON.parse(await readBody(req));
      const saved = catalogFromPlanJson(current.fs.read(current.paths.plan));
      const parsed = parseUiProviderSave(parsedBody, current.paths, saved, {
        expose: readExposeFile(current.fs, current.paths.expose),
        mode: wrapMode(current.fs.read(current.paths.mode)),
      });
      const result = await reconcile(parsed.desired, current);
      if (result.kind === "refused") {
        sendJson(res, 409, result);
        return;
      }
      if (parsed.catalogWrite && parsed.catalogWrite.providers.length === 0) {
        current.fs.remove(current.paths.plan);
      }
      if (parsed.secret) {
        const store = loadSecrets(current.fs, current.paths.secrets);
        saveSecrets(
          current.fs,
          current.paths.secrets,
          upsertSecret(store, parsed.secret.providerId, parsed.secret.bytes),
        );
      }
      const catalog = catalogAfterSave(parsed, catalogFromPlanJson(current.fs.read(current.paths.plan)));
      sendJson(res, 200, {
        ok: true,
        wrapBytesChanged: result.wrapBytesChanged,
        snapshot: snapshotForUi(result.snapshot),
        ...publicState(current, catalog),
      });
    });
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

function safeUiPath(urlPath: string): string | undefined {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const resolved = path.resolve(uiDir, `.${rel}`);
  if (!resolved.startsWith(uiDir)) {
    return undefined;
  }
  return resolved;
}

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}:${String(port)}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      if (await hop.handleHopRequest(req, res)) {
        return;
      }
      const file = safeUiPath(url.pathname);
      if (file === undefined) {
        send(res, 403, "forbidden", "text/plain; charset=utf-8");
        return;
      }
      let body: Buffer;
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) {
          send(res, 404, "not found", "text/plain; charset=utf-8");
          return;
        }
        body = fs.readFileSync(file);
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
        if (code === "ENOENT") {
          send(res, 404, "not found", "text/plain; charset=utf-8");
          return;
        }
        throw err;
      }
      const ext = path.extname(file);
      const type = TYPES[ext] ?? "application/octet-stream";
      send(res, 200, body, type);
    } catch (err) {
      const message = err instanceof Error ? err.message : "error";
      if (!res.headersSent) {
        sendJson(res, 500, { error: message });
      }
    }
  })();
});

server.listen(port, host, () => {
  const box = paths();
  fs.mkdirSync(box.sandData, { recursive: true });
  fs.writeFileSync(box.uiPid, `${String(process.pid)}\n`);
  process.stdout.write(`openbot listening on http://${host}:${String(port)}\n`);
});
