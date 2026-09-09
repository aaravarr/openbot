#!/usr/bin/env bash
# OpenBot one-line installer. Run this on the Grok Bot Computer, not on a Mac.
set -euo pipefail

HOST="${OPENBOT_HOST_MAIN:-/home/box/sand-host/host-main.cjs}"
DATA="${OPENBOT_SAND_DATA:-/home/box/sand-data}"
DEST="${OPENBOT_DEST:-$DATA/openbot}"
DEFAULT_TARBALL="https://codeload.github.com/aaravarr/openbot/tar.gz/refs/heads/main"
REPO_TARBALL="${OPENBOT_TARBALL:-$DEFAULT_TARBALL}"
NODE_DIST="${OPENBOT_NODE_DIST:-https://nodejs.org/dist/v22.18.0}"
NODE_VERSION="v22.18.0"

BOT_RESULT_FILE="${OPENBOT_BOT_RESULT:-$DATA/openbot-install-result.json}"
BOT_LOG_FILE="${OPENBOT_BOT_LOG:-$DATA/openbot-install.log}"
BOT_PID_FILE="${OPENBOT_BOT_PID:-$DATA/openbot-install.pid}"
bot_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
bot_write_result() {
  local status="$1" started="$2" finished="$3" url="$4" qr="$5" error="$6" tail_text="$7" tmp="${BOT_RESULT_FILE}.$$"
  mkdir -p "$(dirname "$BOT_RESULT_FILE")"
  node -e 'const fs=require("fs");const [file,status,startedAt,finishedAt,url,qrPath,error,logTail]=process.argv.slice(1);const result={status,startedAt};if(finishedAt)result.finishedAt=finishedAt;if(url)result.url=url;if(qrPath)result.qrPath=qrPath;if(error)result.error=error;if(logTail)result.logTail=logTail;fs.writeFileSync(file,JSON.stringify(result,null,2)+"\n");' "$tmp" "$status" "$started" "$finished" "$url" "$qr" "$error" "$tail_text"
  mv -f "$tmp" "$BOT_RESULT_FILE"
}
bot_pid_running() {
  local pid="$(tr -d '[:space:]' <"$BOT_PID_FILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 1
  ps -p "$pid" -o args= 2>/dev/null | grep -F -- '--bot-mode-worker' >/dev/null
}
bot_print_status() {
  if [[ ! -f "$BOT_RESULT_FILE" ]]; then
    printf '%s\n' '===== OPENBOT BOT RESULT =====' 'OPENBOT_STATUS=not-installed' "OPENBOT_RESULT_FILE=$BOT_RESULT_FILE" 'OPENBOT_BOT_INSTRUCTION=No detached OpenBot installation has been recorded yet. Run install.sh --bot-mode to start one.' '===== END OPENBOT BOT RESULT ====='
    return 0
  fi
  BOT_LOG_FILE="$BOT_LOG_FILE" node -e 'const fs=require("fs");const file=process.argv[1];let v;try{v=JSON.parse(fs.readFileSync(file,"utf8"));}catch{console.log("===== OPENBOT BOT RESULT =====\nOPENBOT_STATUS=failed\nOPENBOT_ERROR=Result file is not valid JSON.\nOPENBOT_RESULT_FILE="+file+"\n===== END OPENBOT BOT RESULT =====");process.exit(0);}const age=v.status==="running"&&v.startedAt?Date.now()-Date.parse(v.startedAt):0;const lines=["===== OPENBOT BOT RESULT =====","OPENBOT_STATUS="+(v.status||"failed"),"OPENBOT_RESULT_FILE="+file];if(v.startedAt)lines.push("OPENBOT_STARTED_AT="+v.startedAt);if(v.finishedAt)lines.push("OPENBOT_FINISHED_AT="+v.finishedAt);if(v.url)lines.push("OPENBOT_URL="+v.url);if(v.qrPath)lines.push("OPENBOT_QR_PATH="+v.qrPath);if(age>900000)lines.push("OPENBOT_WARNING=Installation may have been interrupted after 15 minutes; check "+(process.env.BOT_LOG_FILE||"the install log")+".");if(v.error)lines.push("OPENBOT_ERROR="+v.error);if(v.logTail)lines.push("OPENBOT_LOG_TAIL="+v.logTail.replace(/\n/g,"\\n"));if(v.status==="running")lines.push("OPENBOT_BOT_INSTRUCTION=Wait 60-120 seconds, then run install.sh --bot-status again.");if(v.status==="success")lines.push("OPENBOT_BOT_INSTRUCTION=Send the tunnel URL and QR image to the user with the host SendToUser tool. Do not expose secrets.");if(v.status==="failed")lines.push("OPENBOT_BOT_INSTRUCTION=Tell the user the installation failed, include the log path, and retry install.sh --bot-mode.");lines.push("===== END OPENBOT BOT RESULT =====");console.log(lines.join("\n"));' "$BOT_RESULT_FILE"
}
bot_worker_exit() {
  local code="$?"
  trap - EXIT
  if [[ "${BOT_WORKER_DONE:-0}" != "1" ]]; then
    bot_write_result failed "${BOT_STARTED_AT:-$(bot_now)}" "$(bot_now)" '' '' "OpenBot detached installation exited with code $code." "$(tail -n 20 "$BOT_LOG_FILE" 2>/dev/null || true)" || true
  fi
  rm -f "$BOT_PID_FILE"
  exit "$code"
}
install_main() {
if [[ ! -f "$HOST" ]]; then
  echo "OpenBot installs on the Grok Bot Computer. Missing $HOST." >&2
  echo "Do not run this script on a Mac. A laptop hop never sees a Bot turn." >&2
  exit 1
fi

ensure_node() {
  local dest="${DATA}/node22"
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
    if [[ "${major}" -ge 22 ]]; then
      return 0
    fi
  fi
  if [[ -x "${dest}/bin/node" ]]; then
    export PATH="${dest}/bin:${PATH}"
    return 0
  fi
  local os arch file
  os="$(uname -s)"
  arch="$(uname -m)"
  case "${os}-${arch}" in
    Linux-x86_64) file="linux-x64" ;;
    Linux-aarch64 | Linux-arm64) file="linux-arm64" ;;
    Darwin-arm64) file="darwin-arm64" ;;
    Darwin-x86_64) file="darwin-x64" ;;
    *)
      echo "OpenBot needs Node 22+. This box has $(command -v node >/dev/null && node -v || echo none) on ${os} ${arch}." >&2
      exit 1
      ;;
  esac
  echo "OpenBot: fetching Node ${NODE_VERSION} into ${dest}" >&2
  mkdir -p "${DATA}"
  local tar
  tar="$(mktemp)"
  curl -fsSL -o "${tar}" "${NODE_DIST}/node-${NODE_VERSION}-${file}.tar.gz"
  rm -rf "${dest}"
  mkdir -p "${dest}"
  tar -xzf "${tar}" -C "${dest}" --strip-components=1
  rm -f "${tar}"
  export PATH="${dest}/bin:${PATH}"
}

# Computer tarball installs have no .git. Stamp payload/version.json so hop can
# send x-openbot-version. Prefer OPENBOT_COMMIT, then git in OPENBOT_SRC, then
# the GitHub SHA for the default main tarball. A lookup miss stamps unknown.
resolve_install_commit() {
  if [[ -n "${OPENBOT_COMMIT:-}" ]]; then
    printf '%s' "${OPENBOT_COMMIT}"
    return
  fi
  if [[ -n "${OPENBOT_SRC:-}" ]] && command -v git >/dev/null 2>&1; then
    local src_sha
    src_sha="$(git -C "${OPENBOT_SRC}" rev-parse HEAD 2>/dev/null || true)"
    if [[ "${src_sha}" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
      printf '%s' "${src_sha}"
      return
    fi
  fi
  if [[ "${REPO_TARBALL}" == "${DEFAULT_TARBALL}" ]] && command -v node >/dev/null 2>&1; then
    local api_sha
    api_sha="$(
      curl -fsSL \
        -H "Accept: application/vnd.github+json" \
        -H "User-Agent: openbot-install" \
        "https://api.github.com/repos/aaravarr/openbot/commits/main" \
        | node -e '
          let s = "";
          process.stdin.on("data", (d) => { s += d; });
          process.stdin.on("end", () => {
            try {
              const row = JSON.parse(s);
              if (row && typeof row.sha === "string") process.stdout.write(row.sha);
            } catch (err) {}
          });
        '
    )" || true
    if [[ "${api_sha}" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
      printf '%s' "${api_sha}"
      return
    fi
  fi
  printf '%s' "unknown"
}

stamp_payload_version() {
  local dest="$1"
  local commit="$2"
  mkdir -p "${dest}/payload"
  node -e '
    const fs = require("fs");
    const dest = process.argv[1];
    const commit = process.argv[2] || "unknown";
    fs.writeFileSync(dest, JSON.stringify({ commit }) + "\n");
  ' "${dest}/payload/version.json" "${commit}"
}

ensure_node

if ! command -v node >/dev/null; then
  echo "OpenBot needs Node on this box." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "OpenBot needs Node 22+. This box has $(node -v)." >&2
  exit 1
fi

mkdir -p "$DATA"

COMMIT="$(resolve_install_commit)"

if [[ -n "${OPENBOT_SRC:-}" ]]; then
  rm -rf "$DEST"
  mkdir -p "$DEST"
  cp -R "$OPENBOT_SRC"/. "$DEST"
else
  TMP="$(mktemp -d)"
  TARBALL="$REPO_TARBALL"
  if [[ "$COMMIT" != "unknown" && "$REPO_TARBALL" == "$DEFAULT_TARBALL" ]]; then
    TARBALL="https://codeload.github.com/aaravarr/openbot/tar.gz/${COMMIT}"
  fi
  curl -fsSL "$TARBALL" | tar -xz -C "$TMP"
  rm -rf "$DEST"
  mv "$TMP"/openbot-* "$DEST"
  rmdir "$TMP" 2>/dev/null || true
fi

stamp_payload_version "$DEST" "$COMMIT"

cd "$DEST"

# Compression deps for payload/image-read.cjs. Two layers keep them available:
#
# 1. Vendored copies in payload/vendor/ (pngjs MIT, jpeg-js BSD-3-Clause, both
#    pure JS, no deps). They ship with the tarball, so offline boxes always
#    have a working compression ladder: the lazy loader resolves the vendored
#    copies first. When both vendored packages are present the npm step is
#    skipped entirely - a blocked registry used to stall installs without any
#    benefit.
# 2. Best-effort `npm install --omit=dev` (only when the vendored copies are
#    missing): the default registry first, then a npmmirror.com retry. If both
#    fail, print a prominent WARN with a remediation hint instead of failing
#    silently - without these libs the hop still routes, but oversized images
#    degrade to omit placeholders instead of being re-encoded.
# OPENBOT_SKIP_NPM_INSTALL=1 skips the npm step (tests and offline mirrors).
payload_vendor_compression_present() {
  [[ -f "$DEST/payload/vendor/pngjs/package.json" && -f "$DEST/payload/vendor/jpeg-js/package.json" ]]
}

warn_npm_install_failed() {
  {
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "WARN: OpenBot could not npm-install the compression libraries."
    echo "      Reason: $1"
    if payload_vendor_compression_present; then
      echo "      Bundled libs in payload/vendor/ cover this: image compression stays available."
    else
      echo "      No bundled libs found: image compression is DISABLED. The hop still"
      echo "      routes, but oversized images degrade to omit placeholders."
      echo "      Remediation: give the box npm registry access (or set a mirror),"
      echo "      then re-run this installer."
    fi
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  } >&2
}

if [[ "${OPENBOT_SKIP_NPM_INSTALL:-}" != "1" ]] && ! payload_vendor_compression_present; then
  if ! command -v npm >/dev/null 2>&1; then
    warn_npm_install_failed "npm is not on PATH"
  elif ! npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1 &&
    ! npm install --omit=dev --no-audit --no-fund --loglevel=error --registry=https://registry.npmmirror.com >/dev/null 2>&1; then
    warn_npm_install_failed "the default npm registry and registry.npmmirror.com both failed"
  fi
fi

# Update path: an old guard daemon (pidfile lock) would otherwise keep running
# the previous release's code, so new guard logic (e.g. hop health patrol)
# never takes effect. Stop it unconditionally here with the freshly swapped-in
# cli.ts (new code always knows `guard --stop`): on a custom box the daemon is
# restarted below from the new tree; on an official box this also clears a
# leftover daemon from a previous custom install. First installs have no
# pidfile and skip silently. Failures never abort the install (set -euo
# pipefail is neutralized with || true).
stop_old_guard_for_update() {
  local pidfile="$DATA/openbot-guard.pid"
  [[ -f "$pidfile" ]] || return 0
  local pid
  pid="$(tr -d '[:space:]' <"$pidfile" 2>/dev/null || true)"
  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    rm -f "$pidfile" || true
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pidfile" || true
    return 0
  fi
  node --experimental-strip-types src/cli.ts guard --stop \
    --host-main "$HOST" --sand-data "$DATA" >/dev/null 2>&1 || true
}

# Update path: a standalone hop-server (payload/hop-server.cjs, pidfile
# openbot-hop.pid) is only restarted for the UI service by reconcile's
# reloadService (uiPid); a live standalone hop keeps serving old code.
# Stop it here so cli.ts install below brings up the new tree. The argv check
# (hop-server must appear) guards against killing a recycled pid, otherwise
# only the stale pidfile is removed. Unified UI mode has no standalone hop
# and skips automatically. All failures are silent.
stop_stale_hop_for_update() {
  local pidfile="$DATA/openbot-hop.pid"
  [[ -f "$pidfile" ]] || return 0
  local pid
  pid="$(tr -d '[:space:]' <"$pidfile" 2>/dev/null || true)"
  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    rm -f "$pidfile" || true
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pidfile" || true
    return 0
  fi
  local args=""
  if [[ -r "/proc/$pid/cmdline" ]]; then
    args="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  else
    args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  fi
  if [[ "$args" == *"hop-server"* ]]; then
    kill "$pid" 2>/dev/null || true
    local waited=0
    while kill -0 "$pid" 2>/dev/null && [[ "$waited" -lt 50 ]]; do
      sleep 0.1 2>/dev/null || true
      waited=$((waited + 1))
    done
    rm -f "$pidfile" || true
  else
    rm -f "$pidfile" || true
  fi
  return 0
}

# Guard first (it patrols hop health and could otherwise restart the hop),
# then the standalone hop. Both are no-ops on a first install.
stop_old_guard_for_update || true
stop_stale_hop_for_update || true

node --experimental-strip-types src/cli.ts install --host-main "$HOST" --sand-data "$DATA"

# Start the in-project guard daemon when the box is custom so drift heals
# without an external scheduler. It never starts on official, never writes the
# official mode token, and never reconciles an official desired state. A live
# daemon makes a second start a no-op (pidfile lock), so re-running install
# stays idempotent. nohup + detached stdio keep the daemon alive after this
# script exits.
if [[ "$(tr -d '[:space:]' <"$DATA/openbot-mode" 2>/dev/null)" == "custom" ]]; then
  nohup node --experimental-strip-types src/cli.ts guard --daemon \
    --host-main "$HOST" --sand-data "$DATA" </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi

if [[ "${1:-}" == "--bot-mode-worker" ]]; then
  BOT_QR_PATH="${OPENBOT_BOT_QR_PATH:-/tmp/openbot-install-qr.png}"
  BOT_RESULT="$(mktemp)"
  BOT_URL=""
  BOT_TUNNEL_ERROR=""
  for BOT_ATTEMPT in 1 2 3; do
    if OPENBOT_TUNNEL=cloudflare node --experimental-strip-types src/cli.ts tunnel on --json >"$BOT_RESULT"; then
      BOT_URL="$(node -e '
        const fs = require("fs");
        try {
          const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          const url = value?.snapshot?.tunnel?.url;
          if (typeof url === "string" && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(url)) process.stdout.write(url);
        } catch {}
      ' "$BOT_RESULT")"
      if [[ -n "$BOT_URL" ]]; then
        break
      fi
      BOT_TUNNEL_ERROR="Tunnel command succeeded but returned no trycloudflare URL."
    else
      BOT_TUNNEL_ERROR="Tunnel attempt ${BOT_ATTEMPT} failed."
    fi
    sleep 2
  done

  if [[ -z "$BOT_URL" ]]; then
    rm -f "$BOT_RESULT"
    echo "OpenBot bot-mode could not obtain a Cloudflare Tunnel URL after 3 attempts." >&2
    echo "${BOT_TUNNEL_ERROR:-Check $DATA/openbot-tunnel.log and retry with: openbot tunnel on}" >&2
    echo "The local control page may still be available at http://127.0.0.1:9280." >&2
    exit 1
  fi

  if ! node --experimental-strip-types src/cli.ts qrcode --text "$BOT_URL" --out "$BOT_QR_PATH" >/dev/null; then
    rm -f "$BOT_RESULT"
    echo "OpenBot bot-mode obtained $BOT_URL but could not write QR PNG to $BOT_QR_PATH." >&2
    echo "Retry with OPENBOT_BOT_QR_PATH set to a writable path." >&2
    exit 1
  fi
  rm -f "$BOT_RESULT"
  bot_write_result success "$BOT_STARTED_AT" "$(bot_now)" "$BOT_URL" "$BOT_QR_PATH" "" ""
  BOT_WORKER_DONE=1

  cat <<EOF

===== OPENBOT BOT RESULT =====
OPENBOT_URL=$BOT_URL
OPENBOT_QR_PATH=$BOT_QR_PATH
OPENBOT_BOT_INSTRUCTION=Send the OpenBot URL to the user. Attach the PNG file at OPENBOT_QR_PATH as an image using the host's SendToUser tool, using the exact image/file parameter names from its installed tool definition. Then briefly confirm that OpenBot is installed and the link is ready. Do not expose secrets or invent a tool name or parameter.
===== END OPENBOT BOT RESULT =====
EOF
fi

}
if [[ "${1:-}" == "--bot-status" ]]; then
  bot_print_status
  exit 0
fi
if [[ "${1:-}" == "--bot-mode" ]]; then
  mkdir -p "$DATA"
  if bot_pid_running; then
    printf '%s\n' '===== OPENBOT BOT RESULT =====' 'OPENBOT_STATUS=started' "OPENBOT_RESULT_FILE=$BOT_RESULT_FILE" "OPENBOT_LOG_FILE=$BOT_LOG_FILE" 'OPENBOT_BOT_INSTRUCTION=Installation is already running; run install.sh --bot-status again after 60-120 seconds.' '===== END OPENBOT BOT RESULT ====='
    exit 0
  fi
  rm -f "$BOT_PID_FILE"
  BOT_STARTED_AT="$(bot_now)"
  export BOT_RESULT_FILE BOT_LOG_FILE BOT_PID_FILE BOT_STARTED_AT
  bot_write_result running "$BOT_STARTED_AT" '' '' '' '' ''
  export -f bot_now bot_write_result bot_pid_running bot_print_status bot_worker_exit install_main
  (setsid nohup bash -c 'trap bot_worker_exit EXIT; BOT_WORKER_DONE=0; install_main --bot-mode-worker' </dev/null >>"$BOT_LOG_FILE" 2>&1) &
  printf '%s\\n' "$!" >"${BOT_PID_FILE}.tmp"
  mv -f "${BOT_PID_FILE}.tmp" "$BOT_PID_FILE"
  printf '%s\n' '===== OPENBOT BOT RESULT =====' 'OPENBOT_STATUS=started' "OPENBOT_RESULT_FILE=$BOT_RESULT_FILE" "OPENBOT_LOG_FILE=$BOT_LOG_FILE" 'OPENBOT_BOT_INSTRUCTION=Reply to the user now: OpenBot installation has started. After 60-120 seconds (or in the next turn), run install.sh --bot-status. When status=success, send the tunnel URL and QR image to the user with the host SendToUser tool. Do not expose secrets.' '===== END OPENBOT BOT RESULT ====='
  exit 0
fi
install_main "$@"
