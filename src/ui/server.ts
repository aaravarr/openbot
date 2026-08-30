import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOOPBACK, UI_PORT } from "../domain/types.ts";
import { parseUiProviderSave } from "../parse/ui.ts";
import { boxPathsFrom } from "../supervisor/paths.ts";
import { catalogFromPlanJson } from "../supervisor/plan.ts";
import { observe, type SupervisorDeps } from "../supervisor/observe.ts";
import { nodeFs, nodeProcs } from "../supervisor/procs.ts";
import { reconcile } from "../supervisor/reconcile.ts";
import { loadSecrets, saveSecrets, upsertSecret } from "../supervisor/secrets.ts";

const repoRoot = process.env.OPENBOT_REPO ?? fileURLToPath(new URL("../..", import.meta.url));
const uiDir = path.join(repoRoot, "ui");
const host = process.env.OPENBOT_UI_HOST ?? LOOPBACK;
const port = Number(process.env.OPENBOT_UI_PORT ?? String(UI_PORT));

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
  res.writeHead(status, { "Content-Type": type, "Content-Length": String(buf.length) });
  res.end(buf);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function publicState(current: SupervisorDeps) {
  const catalog = catalogFromPlanJson(current.fs.read(current.paths.plan));
  const store = loadSecrets(current.fs, current.paths.secrets);
  const keyedProviders = Object.keys(store.providers);
  const active = catalog.bindings.find((row) => row.conversation.kind === "wildcard");
  return {
    catalog,
    keyedProviders,
    activeModelId: active?.modelId ?? null,
  };
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const current = deps();
  if (req.method === "GET" && (url.pathname === "/api/snapshot" || url.pathname === "/api/state")) {
    const snapshot = await observe(current);
    send(
      res,
      200,
      JSON.stringify({ snapshot, ...publicState(current) }),
      "application/json; charset=utf-8",
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/catalog") {
    send(res, 200, JSON.stringify(publicState(current)), "application/json; charset=utf-8");
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/save") {
    const parsedBody: unknown = JSON.parse(await readBody(req));
    const catalog = catalogFromPlanJson(current.fs.read(current.paths.plan));
    const parsed = parseUiProviderSave(parsedBody, current.paths, catalog);
    const result = await reconcile(parsed.desired, current);
    if (result.kind === "refused") {
      send(res, 409, JSON.stringify(result), "application/json; charset=utf-8");
      return;
    }
    if (parsed.secret) {
      const store = loadSecrets(current.fs, current.paths.secrets);
      saveSecrets(current.fs, current.paths.secrets, upsertSecret(store, parsed.secret.providerId, parsed.secret.bytes));
    }
    send(
      res,
      200,
      JSON.stringify({
        ok: true,
        wrapBytesChanged: result.wrapBytesChanged,
        snapshot: result.snapshot,
        ...publicState(current),
      }),
      "application/json; charset=utf-8",
    );
    return;
  }
  send(res, 404, JSON.stringify({ error: "not found" }), "application/json; charset=utf-8");
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
      const file = safeUiPath(url.pathname);
      if (file === undefined) {
        send(res, 403, "forbidden", "text/plain; charset=utf-8");
        return;
      }
      const ext = path.extname(file);
      const type = TYPES[ext] ?? "application/octet-stream";
      send(res, 200, fs.readFileSync(file), type);
    } catch (err) {
      const message = err instanceof Error ? err.message : "error";
      if (!res.headersSent) {
        send(res, 500, JSON.stringify({ error: message }), "application/json; charset=utf-8");
      }
    }
  })();
});

server.listen(port, host, () => {
  const box = paths();
  fs.mkdirSync(box.sandData, { recursive: true });
  fs.writeFileSync(box.uiPid, `${String(process.pid)}\n`);
  process.stdout.write(`openbot-ui listening on http://${host}:${String(port)}\n`);
});
