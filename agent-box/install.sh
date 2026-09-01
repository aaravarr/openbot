#!/usr/bin/env bash
# OpenBot agent-box: one-file HTTP remote on this Computer plus a Cloudflare quick tunnel.
# GET the printed URL for agent docs. Anyone with that URL can run commands here.
set -euo pipefail

DATA="${AGENT_BOX_DATA:-/home/box/sand-data/agent-box}"
PORT="${AGENT_BOX_PORT:-9281}"
HOST="127.0.0.1"
SKIP_TUNNEL="${AGENT_BOX_SKIP_TUNNEL:-0}"
OPENBOT_PORT=9280

usage() {
  cat >&2 <<'EOF'
OpenBot agent-box — HTTP remote for agents on this Computer.

  bash install.sh              start (default); print the public URL
  bash install.sh start        same; reuse a live instance
  bash install.sh restart      stop, then start a new tunnel
  bash install.sh stop         stop HTTP + cloudflared
  bash install.sh status       print the URL if live

Environment:
  AGENT_BOX_DATA         state dir (default /home/box/sand-data/agent-box)
  AGENT_BOX_PORT         loopback port (default 9281; 9280 is refused)
  AGENT_BOX_SKIP_TUNNEL  1 = loopback only, no Cloudflare
  AGENT_BOX_JSON         1 = print one JSON object on stdout

One-line install:

  curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/agent-box/install.sh | bash
EOF
}

die() {
  echo "agent-box: $*" >&2
  exit 1
}

need_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
    if [[ "${major}" -ge 18 ]]; then
      return 0
    fi
  fi
  if [[ -x /home/box/sand-data/node22/bin/node ]]; then
    export PATH="/home/box/sand-data/node22/bin:${PATH}"
    return 0
  fi
  die "needs Node 18+ (OpenBot puts Node 22 in /home/box/sand-data/node22)"
}

port_is_open() {
  node -e '
    const net = require("node:net");
    const port = Number(process.argv[1]);
    const host = process.argv[2];
    const s = net.createConnection({ host, port });
    s.setTimeout(400);
    s.on("connect", () => { s.end(); process.exit(0); });
    s.on("timeout", () => { s.destroy(); process.exit(1); });
    s.on("error", () => process.exit(1));
  ' "$1" "$HOST"
}

pid_alive() {
  local pid="$1"
  [[ -n "${pid}" && "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null
}

read_pid() {
  local file="$1"
  if [[ -f "${file}" ]]; then
    tr -d '[:space:]' < "${file}" || true
  fi
}

stop_pidfile() {
  local file="$1"
  local pid
  pid="$(read_pid "${file}")"
  if pid_alive "${pid}"; then
    kill "${pid}" 2>/dev/null || true
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
      pid_alive "${pid}" || break
      sleep 0.1
    done
    if pid_alive "${pid}"; then
      kill -TERM "${pid}" 2>/dev/null || true
    fi
  fi
  rm -f "${file}"
}

cmd="${1:-start}"
if [[ "${cmd}" == "-h" || "${cmd}" == "--help" || "${cmd}" == "help" ]]; then
  usage
  exit 0
fi

if [[ "${PORT}" == "${OPENBOT_PORT}" ]]; then
  die "port ${OPENBOT_PORT} is OpenBot. Use AGENT_BOX_PORT (default 9281)."
fi
if [[ ! "${PORT}" =~ ^[0-9]+$ ]] || [[ "${PORT}" -lt 1 || "${PORT}" -gt 65535 ]]; then
  die "AGENT_BOX_PORT must be a TCP port"
fi

mkdir -p "${DATA}"
HTTP_PID="${DATA}/http.pid"
TUNNEL_PID="${DATA}/tunnel.pid"
HTTP_LOG="${DATA}/http.log"
TUNNEL_LOG="${DATA}/tunnel.log"
TOKEN_FILE="${DATA}/token"
URL_FILE="${DATA}/url"
SERVER_FILE="${DATA}/server.cjs"
BIN_DIR="${DATA}/bin"
CF_BIN="${BIN_DIR}/cloudflared"
OPENBOT_CF="/home/box/sand-data/bin/cloudflared"

stop_all() {
  stop_pidfile "${TUNNEL_PID}"
  stop_pidfile "${HTTP_PID}"
}

health_ok() {
  local token="$1"
  node -e '
    const http = require("node:http");
    const port = process.argv[1];
    const token = process.argv[2];
    const req = http.get(
      { host: "127.0.0.1", port, path: "/v/" + token + "/health", timeout: 800 },
      (res) => { res.resume(); process.exit(res.statusCode === 200 ? 0 : 1); },
    );
    req.on("timeout", () => { req.destroy(); process.exit(1); });
    req.on("error", () => process.exit(1));
  ' "${PORT}" "${token}"
}

status_url() {
  if [[ -f "${URL_FILE}" ]]; then
    tr -d '[:space:]' < "${URL_FILE}"
  fi
}

write_stop_helper() {
  cat > "${DATA}/stop" <<'END'
#!/usr/bin/env bash
set -euo pipefail
data="$(cd "$(dirname "$0")" && pwd)"
for f in "${data}/http.pid" "${data}/tunnel.pid"; do
  if [[ -f "${f}" ]]; then
    pid="$(tr -d '[:space:]' < "${f}" || true)"
    if [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
    fi
    rm -f "${f}"
  fi
done
echo "agent-box: stopped" >&2
END
  chmod 755 "${DATA}/stop"
}

emit_url() {
  local url="$1"
  printf '%s\n' "${url}" > "${URL_FILE}"
  chmod 600 "${URL_FILE}" 2>/dev/null || true
  write_stop_helper
  if [[ "${AGENT_BOX_JSON:-0}" == "1" ]]; then
    node -e 'const u=process.argv[1]; process.stdout.write(JSON.stringify({url:u,internal:"http://127.0.0.1:"+process.argv[2]})+"\n")' "${url}" "${PORT}"
  else
    printf '%s\n' "${url}"
  fi
  cat >&2 <<EOF
agent-box: anyone with that URL can run commands and read/write files on this Computer.
agent-box: loopback http://${HOST}:${PORT}
agent-box: stop with: ${DATA}/stop
agent-box: or: curl -fsSL https://raw.githubusercontent.com/aaravarr/openbot/main/agent-box/install.sh | bash -s stop
EOF
}

case "${cmd}" in
  stop)
    stop_all
    echo "agent-box: stopped" >&2
    exit 0
    ;;
  status)
    token=""
    if [[ -f "${TOKEN_FILE}" ]]; then
      token="$(tr -d '[:space:]' < "${TOKEN_FILE}")"
    fi
    if [[ -n "${token}" ]] && pid_alive "$(read_pid "${HTTP_PID}")" && health_ok "${token}"; then
      url="$(status_url)"
      if [[ -z "${url}" ]]; then
        url="http://${HOST}:${PORT}/v/${token}"
      fi
      emit_url "${url}"
      exit 0
    fi
    die "not running"
    ;;
  restart)
    stop_all
    cmd="start-fresh"
    ;;
  start)
    ;;
  start-fresh)
    ;;
  *)
    usage
    die "unknown command ${cmd}"
    ;;
esac

need_node

if [[ "${cmd}" == "start" && -f "${TOKEN_FILE}" ]]; then
  token="$(tr -d '[:space:]' < "${TOKEN_FILE}")"
  if [[ -n "${token}" ]] && pid_alive "$(read_pid "${HTTP_PID}")" && health_ok "${token}"; then
    url="$(status_url)"
    if [[ "${SKIP_TUNNEL}" == "1" ]]; then
      emit_url "http://${HOST}:${PORT}/v/${token}"
      exit 0
    fi
    if [[ -n "${url}" ]] && pid_alive "$(read_pid "${TUNNEL_PID}")"; then
      emit_url "${url}"
      exit 0
    fi
  fi
fi

if port_is_open "${PORT}"; then
  token=""
  if [[ -f "${TOKEN_FILE}" ]]; then
    token="$(tr -d '[:space:]' < "${TOKEN_FILE}")"
  fi
  if [[ -z "${token}" ]] || ! health_ok "${token}"; then
    die "port ${PORT} is already in use. It will not take it over."
  fi
fi

stop_all

if [[ -f "${TOKEN_FILE}" ]]; then
  TOKEN="$(tr -d '[:space:]' < "${TOKEN_FILE}")"
fi
if [[ -z "${TOKEN:-}" ]]; then
  TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))")"
  printf '%s\n' "${TOKEN}" > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
fi

cat > "${SERVER_FILE}" <<'END_SERVER'
"use strict";

const http = require("node:http");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const TOKEN = process.env.AGENT_BOX_TOKEN || "";
const PORT = Number(process.env.AGENT_BOX_PORT || "9281");
const HOST = "127.0.0.1";
const MAX_BODY = 8 * 1024 * 1024;
const MAX_CAPTURE = 2 * 1024 * 1024;
const MAX_TIMEOUT = 300_000;
const DEFAULT_TIMEOUT = 60_000;
const MAX_EXEC = 8;

let running = 0;

function docsFor(base) {
  return `# OpenBot agent-box

This URL is a remote for **this Computer**. Anyone who has it can run commands and read or write files. Treat it as a secret. trycloudflare hostnames expire; run the installer again to get a new one.

Base: ${base}

Auth is the path prefix \`/v/<token>\`. You can also send \`Authorization: Bearer <token>\` and call the routes at the root (\`/health\`, \`/exec\`, \`/fs\`).

## Routes

GET  ${base}/
GET  ${base}/help
     This document (text/plain).

GET  ${base}/health
     JSON: user, cwd, hostname, platform, arch, now, pid.

POST ${base}/exec
     JSON body (one of):
       {"cmd":"uname -a"}
       {"argv":["ls","-la"],"cwd":"/home/box"}
     Optional: timeoutMs (default 60000, max 300000), env {KEY:VALUE}, stdin string.
     \`cmd\` runs \`/bin/bash -lc\`. Prefer \`argv\` when you do not need a shell.
     Response: {ok, code, signal, stdout, stderr, cwd, ms, truncated}.

GET  ${base}/fs?path=/abs/or/relative
     Read a file. JSON {path, size, encoding: "utf8"|"base64", body}. Max 8MB.

PUT  ${base}/fs?path=...
     Write the raw request body to that path (max 8MB).
     JSON body also works: {"text":"..."} or {"base64":"..."} and optional {"mode":420}.

POST ${base}/fs
     JSON {op, path, ...}:
       {"op":"stat","path":"/tmp"}
       {"op":"list","path":"/tmp"}
       {"op":"mkdir","path":"/tmp/a","recursive":true}
       {"op":"rm","path":"/tmp/a","recursive":false}
     \`rm\` of \`/\` is refused.

Bind is loopback only. Cloudflare quick tunnel is HTTP(S); this is not sshd.
`;
}

function send(res, status, body, headers) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  res.writeHead(status, {
    "content-length": buf.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(buf);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2) + "\n", {
    "content-type": "application/json; charset=utf-8",
  });
}

function sendText(res, status, text) {
  send(res, status, text.endsWith("\n") ? text : `${text}\n`, {
    "content-type": "text/plain; charset=utf-8",
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (chunk) => {
      n += chunk.length;
      if (n > MAX_BODY) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function tokenFrom(req, url) {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const q = url.searchParams.get("token");
  if (q) {
    return q;
  }
  const m = url.pathname.match(/^\/v\/([^/]+)/);
  return m ? m[1] : "";
}

function routeOf(url, token) {
  const prefix = `/v/${token}`;
  let pathname = url.pathname;
  if (pathname === prefix) {
    return "/";
  }
  if (pathname.startsWith(`${prefix}/`)) {
    pathname = pathname.slice(prefix.length) || "/";
  }
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  return pathname || "/";
}

function resolvePath(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("path is required");
  }
  const home = process.env.HOME || os.homedir() || "/home/box";
  const p = path.resolve(raw.startsWith("/") ? raw : path.join(home, raw));
  return p;
}

function cap(buf) {
  if (buf.length <= MAX_CAPTURE) {
    return { text: buf.toString("utf8"), truncated: false };
  }
  return { text: buf.subarray(0, MAX_CAPTURE).toString("utf8"), truncated: true };
}

function runExec(input) {
  if (running >= MAX_EXEC) {
    const err = new Error("too many execs");
    err.code = "busy";
    throw err;
  }
  const timeoutMs = Math.min(
    MAX_TIMEOUT,
    Math.max(1, Number(input.timeoutMs) || DEFAULT_TIMEOUT),
  );
  let file;
  let args;
  if (Array.isArray(input.argv) && input.argv.length > 0) {
    file = String(input.argv[0]);
    args = input.argv.slice(1).map((row) => String(row));
  } else if (typeof input.cmd === "string" && input.cmd.trim() !== "") {
    file = "/bin/bash";
    args = ["-lc", input.cmd];
  } else {
    throw new Error("exec needs cmd or argv");
  }
  const cwd = typeof input.cwd === "string" && input.cwd.trim() !== "" ? input.cwd : (process.env.HOME || os.homedir() || process.cwd());
  const env = { ...process.env, ...(input.env && typeof input.env === "object" ? input.env : {}) };
  delete env.AGENT_BOX_TOKEN;
  const stdin = typeof input.stdin === "string" ? input.stdin : undefined;
  running += 1;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    let outN = 0;
    let errN = 0;
    const bump = (store, nRef, chunk, which) => {
      const take = chunk.subarray(0, Math.max(0, MAX_CAPTURE + 1 - nRef.value));
      if (take.length) {
        store.push(take);
        nRef.value += take.length;
      }
      void which;
    };
    const outRef = { value: 0 };
    const errRef = { value: 0 };
    child.stdout.on("data", (chunk) => bump(out, outRef, chunk, "out"));
    child.stderr.on("data", (chunk) => bump(err, errRef, chunk, "err"));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      running -= 1;
      const stdout = cap(Buffer.concat(out));
      const stderr = cap(Buffer.concat(err));
      resolve({
        ok: false,
        code: null,
        signal: null,
        stdout: stdout.text,
        stderr: (stderr.text ? stderr.text + "\n" : "") + e.message,
        cwd,
        ms: Date.now() - started,
        truncated: stdout.truncated || stderr.truncated,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      running -= 1;
      const stdout = cap(Buffer.concat(out));
      const stderr = cap(Buffer.concat(err));
      resolve({
        ok: code === 0,
        code,
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
        cwd,
        ms: Date.now() - started,
        truncated: stdout.truncated || stderr.truncated,
      });
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

async function handleFsGet(filePath) {
  const st = await fsp.stat(filePath);
  if (st.isDirectory()) {
    throw new Error("path is a directory; POST {op:\"list\",path}");
  }
  if (st.size > MAX_BODY) {
    throw new Error("file larger than 8MB");
  }
  const buf = await fsp.readFile(filePath);
  const utf8 = !buf.includes(0) && Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
  return {
    path: filePath,
    size: buf.length,
    encoding: utf8 ? "utf8" : "base64",
    body: utf8 ? buf.toString("utf8") : buf.toString("base64"),
  };
}

async function handleFsPut(filePath, buf, json) {
  let data = buf;
  let mode;
  if (json && typeof json === "object" && !Array.isArray(json)) {
    if (typeof json.text === "string") {
      data = Buffer.from(json.text, "utf8");
    } else if (typeof json.base64 === "string") {
      data = Buffer.from(json.base64, "base64");
    }
    if (typeof json.mode === "number") {
      mode = json.mode;
    }
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, data, mode !== undefined ? { mode } : undefined);
  return { ok: true, path: filePath, size: data.length };
}

async function handleFsPost(body) {
  const op = body.op;
  const filePath = resolvePath(body.path);
  if (op === "stat") {
    const st = await fsp.stat(filePath);
    return {
      path: filePath,
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      size: st.size,
      mode: st.mode,
      mtimeMs: st.mtimeMs,
    };
  }
  if (op === "list") {
    const rows = await fsp.readdir(filePath, { withFileTypes: true });
    return {
      path: filePath,
      entries: rows.map((row) => ({
        name: row.name,
        isDirectory: row.isDirectory(),
        isFile: row.isFile(),
      })),
    };
  }
  if (op === "mkdir") {
    await fsp.mkdir(filePath, { recursive: body.recursive !== false });
    return { ok: true, path: filePath };
  }
  if (op === "rm") {
    if (filePath === "/") {
      throw new Error("refusing to rm /");
    }
    await fsp.rm(filePath, { recursive: Boolean(body.recursive), force: true });
    return { ok: true, path: filePath };
  }
  throw new Error("fs op is stat, list, mkdir, or rm");
}

function parseJson(buf) {
  if (!buf.length) {
    return {};
  }
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error("body is not JSON");
  }
}

function publicBase(req, url) {
  const host = req.headers.host || `${HOST}:${PORT}`;
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${host}/v/${TOKEN}`;
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const got = tokenFrom(req, url);
  if (!TOKEN || got !== TOKEN) {
    sendText(res, 401, "unauthorized");
    return;
  }
  const route = routeOf(url, TOKEN);
  const method = (req.method || "GET").toUpperCase();

  if ((route === "/" || route === "/help") && (method === "GET" || method === "HEAD")) {
    const text = docsFor(publicBase(req, url));
    if (method === "HEAD") {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(text),
      });
      res.end();
      return;
    }
    sendText(res, 200, text);
    return;
  }

  if (route === "/health" && (method === "GET" || method === "HEAD")) {
    sendJson(res, 200, {
      ok: true,
      user: os.userInfo().username,
      cwd: process.cwd(),
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      now: new Date().toISOString(),
      pid: process.pid,
      home: process.env.HOME || os.homedir(),
    });
    return;
  }

  if (route === "/exec" && method === "POST") {
    const buf = await readBody(req);
    const body = parseJson(buf);
    try {
      const result = await runExec(body);
      sendJson(res, result.ok ? 200 : 200, result);
    } catch (err) {
      if (err && err.code === "busy") {
        sendJson(res, 503, { error: err.message });
        return;
      }
      sendJson(res, 400, { error: err instanceof Error ? err.message : "exec failed" });
    }
    return;
  }

  if (route === "/fs" && method === "GET") {
    const filePath = resolvePath(url.searchParams.get("path") || "");
    sendJson(res, 200, await handleFsGet(filePath));
    return;
  }

  if (route === "/fs" && method === "PUT") {
    const filePath = resolvePath(url.searchParams.get("path") || "");
    const buf = await readBody(req);
    let json;
    const ct = String(req.headers["content-type"] || "");
    if (ct.includes("application/json")) {
      json = parseJson(buf);
    }
    sendJson(res, 200, await handleFsPut(filePath, buf, json));
    return;
  }

  if (route === "/fs" && method === "POST") {
    const buf = await readBody(req);
    sendJson(res, 200, await handleFsPost(parseJson(buf)));
    return;
  }

  sendJson(res, 404, { error: "not found", hint: "GET / for docs" });
}

if (!TOKEN) {
  console.error("agent-box: AGENT_BOX_TOKEN is missing");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) {
      const msg = err instanceof Error ? err.message : "internal error";
      const status = /required|not JSON|path is|refusing|larger than|directory|exec needs/.test(msg) ? 400 : 500;
      sendJson(res, status, { error: msg });
    } else {
      res.end();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.error(`agent-box http listening on http://${HOST}:${PORT}`);
});

server.on("error", (err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
END_SERVER

export AGENT_BOX_TOKEN="${TOKEN}"
export AGENT_BOX_PORT="${PORT}"
if [[ -d /home/box ]]; then
  cd /home/box
elif [[ -n "${HOME:-}" && -d "${HOME}" ]]; then
  cd "${HOME}"
fi

nohup node "${SERVER_FILE}" >> "${HTTP_LOG}" 2>&1 &
echo $! > "${HTTP_PID}"
chmod 600 "${HTTP_PID}" 2>/dev/null || true

ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if health_ok "${TOKEN}"; then
    ok=1
    break
  fi
  if ! pid_alive "$(read_pid "${HTTP_PID}")"; then
    die "HTTP process exited. See ${HTTP_LOG}"
  fi
  sleep 0.1
done
if [[ "${ok}" != "1" ]]; then
  die "HTTP did not become ready on ${HOST}:${PORT}. See ${HTTP_LOG}"
fi

LOCAL_URL="http://${HOST}:${PORT}/v/${TOKEN}"

if [[ "${SKIP_TUNNEL}" == "1" ]]; then
  emit_url "${LOCAL_URL}"
  exit 0
fi

ensure_cloudflared() {
  if [[ -x "${CF_BIN}" ]]; then
    return 0
  fi
  if [[ -x "${OPENBOT_CF}" ]]; then
    mkdir -p "${BIN_DIR}"
    cp "${OPENBOT_CF}" "${CF_BIN}"
    chmod 755 "${CF_BIN}"
    return 0
  fi
  mkdir -p "${BIN_DIR}"
  local os arch asset
  os="$(uname -s)"
  arch="$(uname -m)"
  case "${os}-${arch}" in
    Linux-x86_64) asset="cloudflared-linux-amd64" ;;
    Linux-aarch64 | Linux-arm64) asset="cloudflared-linux-arm64" ;;
    Darwin-arm64) asset="cloudflared-darwin-arm64" ;;
    Darwin-x86_64) asset="cloudflared-darwin-amd64" ;;
    *) die "unsupported platform ${os} ${arch} for cloudflared" ;;
  esac
  echo "agent-box: fetching cloudflared (${asset})" >&2
  curl -fsSL -o "${CF_BIN}" "https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}"
  chmod 755 "${CF_BIN}"
}

parse_cf_url() {
  if [[ ! -f "${TUNNEL_LOG}" ]]; then
    return 0
  fi
  grep -oE 'https://[a-z0-9-]+\.trycloudflare.com' "${TUNNEL_LOG}" 2>/dev/null | tail -n 1 || true
}

ensure_cloudflared
: > "${TUNNEL_LOG}"
nohup "${CF_BIN}" tunnel --no-autoupdate --url "http://${HOST}:${PORT}" >> "${TUNNEL_LOG}" 2>&1 &
echo $! > "${TUNNEL_PID}"
chmod 600 "${TUNNEL_PID}" 2>/dev/null || true

cf=""
for _ in $(seq 1 80); do
  cf="$(parse_cf_url)"
  if [[ -n "${cf}" ]]; then
    break
  fi
  if ! pid_alive "$(read_pid "${TUNNEL_PID}")"; then
    die "cloudflared exited. See ${TUNNEL_LOG}"
  fi
  sleep 0.25
done
if [[ -z "${cf}" ]]; then
  die "Cloudflare Tunnel started but no public URL appeared. See ${TUNNEL_LOG}"
fi

emit_url "${cf}/v/${TOKEN}"
exit 0
