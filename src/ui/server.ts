import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOOPBACK, SERVICE_PORT, type Catalog, type Snapshot, type TunnelObserved } from "../domain/types.ts";
import { grokSkillsStatus, installGrokSkills, isSkillSlug } from "../grok-skills.ts";
import { officialBox } from "../parse/argv.ts";
import { fetchModelsForProvider } from "../catalog/provider-models.ts";
import { createCatalogManager } from "../catalog/model-catalog.ts";
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

let catalogManager: ReturnType<typeof createCatalogManager> | undefined;

function modelCatalog() {
  if (catalogManager === undefined) {
    catalogManager = createCatalogManager({
      fs: nodeFs(),
      cachePath: paths().modelCatalog,
    });
  }
  return catalogManager;
}

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

/**
 * Strict read of the mode file. Only the literal token "official" means
 * official; anything else (missing, empty, garbage) means custom. Users own
 * custom state and often have zero official quota, so an unreadable mode file
 * must never reconcile chat back to official.
 */
export function wrapMode(raw: string | undefined): "official" | "custom" {
  return raw?.trim() === "official" ? "official" : "custom";
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
  const channel = url.searchParams.get("channel") ?? "";
  if (channel.trim()) {
    query.channel = channel.trim();
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

function providerIdFromFetchPath(pathname: string): string | undefined {
  const prefix = "/api/providers/";
  const suffix = "/fetch-models";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return undefined;
  }
  const rest = pathname.slice(prefix.length, pathname.length - suffix.length);
  if (!rest || rest.includes("/")) {
    return undefined;
  }
  try {
    return decodeURIComponent(rest);
  } catch {
    return undefined;
  }
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
      await enqueueSave(async () => {
        const saved = requestLog.saveSettings(parsed);
        let wrapBytesChanged = false;
        let wrapError: string | undefined;
        const current = deps();
        if (wrapMode(current.fs.read(current.paths.mode)) === "official") {
          const result = await reconcile(
            officialBox(current.paths, readExposeFile(current.fs, current.paths.expose)),
            current,
            { source: "ui:logs-settings" },
          );
          if (result.kind === "refused") {
            wrapError = result.error.kind;
          } else {
            wrapBytesChanged = result.wrapBytesChanged;
          }
        }
        sendJson(res, 200, { ...saved, wrapBytesChanged, wrapError });
      });
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

function parseInstallSlug(parsed: unknown): { ok: true; slug?: string } | { ok: false; error: string } {
  if (parsed === null || parsed === undefined) {
    return { ok: true };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "invalid json" };
  }
  if (!("slug" in parsed)) {
    return { ok: true };
  }
  const raw = (parsed as { slug?: unknown }).slug;
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true };
  }
  if (typeof raw !== "string" || !isSkillSlug(raw)) {
    return { ok: false, error: "invalid slug" };
  }
  return { ok: true, slug: raw };
}

async function handleGrokSkillsApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/api/grok-skills") {
    const report = await grokSkillsStatus({ repoRoot });
    sendJson(res, 200, report);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/grok-skills/install") {
    let parsed: unknown = {};
    const raw = await readBody(req);
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        sendJson(res, 400, { error: "invalid json" });
        return true;
      }
    }
    const slug = parseInstallSlug(parsed);
    if (!slug.ok) {
      sendJson(res, 400, { error: slug.error });
      return true;
    }
    const result = await enqueueSave(async () => {
      if (slug.slug !== undefined) {
        return installGrokSkills({ repoRoot, slug: slug.slug });
      }
      return installGrokSkills({ repoRoot });
    });
    if (result.ok) {
      sendJson(res, 200, { ok: true, ...result.report });
      return true;
    }
    sendJson(res, result.status, { ok: false, error: result.error, ...result.report });
    return true;
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
  if (req.method === "GET" && url.pathname === "/api/model-catalog") {
    const modelId = url.searchParams.get("modelId") ?? undefined;
    sendJson(res, 200, modelCatalog().snapshot(modelId));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/model-catalog/refresh") {
    const { startedAt } = modelCatalog().refresh();
    sendJson(res, 202, { ok: true, status: "loading", startedAt });
    return;
  }
  if (req.method === "POST") {
    const providerId = providerIdFromFetchPath(url.pathname);
    if (providerId !== undefined) {
      const catalog = catalogFromPlanJson(current.fs.read(current.paths.plan));
      const store = loadSecrets(current.fs, current.paths.secrets);
      const result = await fetchModelsForProvider({ providerId, catalog, secretStore: store });
      sendJson(res, result.status, result.body);
      return;
    }
  }
  if (await handleGrokSkillsApi(req, res, url)) {
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
      const result = await reconcile(parsed.desired, current, { source: `ui:save:${parsed.kind}` });
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
  // Resolve both sides so a Unix-style env path (e.g. OPENBOT_REPO=/Code/...) and
  // the drive-lettered cwd resolve to the same absolute, normalized form on win32.
  const base = path.resolve(uiDir);
  const compare = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const resolvedKey = compare(resolved);
  const baseKey = compare(base);
  // Require a trailing separator so a sibling prefix like "<ui>-evil" cannot pass.
  if (resolvedKey !== baseKey && !resolvedKey.startsWith(baseKey + path.sep)) {
    return undefined;
  }
  return resolved;
}

export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
    // A handler (sync or async) threw: return a structured 500 rather than
    // letting the rejection escape into an uncaught exception.
    const message = err instanceof Error ? err.message : "internal error";
    if (!res.headersSent) {
      sendJson(res, 500, { error: { kind: "internal", message } });
    }
  }
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res);
});

/**
 * Last-resort process guards. This is a single-user local tool: staying up
 * beats dying, so an unexpected exception or rejection is logged (with stack)
 * and the process keeps serving. These are a final safety net only — they are
 * NOT a substitute for local error handling; every child_process spawn and
 * async handler must still surface its own failures.
 */
export function registerProcessFallbacks(
  log: (line: string) => void = (line) => process.stderr.write(line),
): void {
  process.on("uncaughtException", (err) => {
    log(`OpenBot: uncaught exception (process kept alive): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  });
  process.on("unhandledRejection", (reason) => {
    log(
      `OpenBot: unhandled rejection (process kept alive): ${
        reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
      }\n`,
    );
  });
}

function startServer(): void {
  registerProcessFallbacks();
  server.listen(port, host, () => {
    const box = paths();
    fs.mkdirSync(box.sandData, { recursive: true });
    fs.writeFileSync(box.uiPid, `${String(process.pid)}\n`);
    // Non-blocking: load the public catalog cache from disk, then re-fetch in the background.
    void modelCatalog().start();
    process.stdout.write(`openbot listening on http://${host}:${String(port)}\n`);
  });
}

// Start only when this file is the entry point; importing it (e.g. from tests)
// must not open a listener or install the process guards.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
