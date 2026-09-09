#!/usr/bin/env bash
# OpenBot one-line installer. Run this on the Grok Bot Computer, not on a Mac.
set -euo pipefail

HOST="${OPENBOT_HOST_MAIN:-/home/box/sand-host/host-main.cjs}"
DATA="${OPENBOT_SAND_DATA:-/home/box/sand-data}"
DEST="${OPENBOT_DEST:-$DATA/openbot}"
DEFAULT_TARBALL="https://codeload.github.com/aaravarr/openbot/tar.gz/refs/heads/main"
REPO_TARBALL="${OPENBOT_TARBALL:-$DEFAULT_TARBALL}"
DEFAULT_ARCHIVE_TARBALL="https://github.com/aaravarr/openbot/archive/refs/heads/main.tar.gz"
ARCHIVE_TARBALL="${OPENBOT_ARCHIVE_TARBALL:-$DEFAULT_ARCHIVE_TARBALL}"
NODE_DIST="${OPENBOT_NODE_DIST:-https://nodejs.org/dist/v22.18.0}"
NODE_VERSION="v22.18.0"

BOT_RESULT_FILE="${OPENBOT_BOT_RESULT:-$DATA/openbot-install-result.json}"
BOT_LOG_FILE="${OPENBOT_BOT_LOG:-$DATA/openbot-install.log}"
BOT_PID_FILE="${OPENBOT_BOT_PID:-$DATA/openbot-install.pid}"
bot_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
bot_epoch_ms() { date +%s%3N; }
bot_write_state() {
  local status="$1" started="$2" finished="$3" url="$4" qr="$5" error="$6" tail_text="$7" stage="$8" summary="$9" rolled_back="${10:-}" download_source="${11:-${OPENBOT_DOWNLOAD_SOURCE:-}}" tmp="${BOT_RESULT_FILE}.$$"
  mkdir -p "$(dirname "$BOT_RESULT_FILE")"
  OPENBOT_INSTALL_COMMIT="${OPENBOT_INSTALL_COMMIT:-}" node -e 'const fs=require("fs");const [file,status,startedAt,finishedAt,url,qrPath,error,logTail,stage,summary,downloadMs,deployMs,restartMs,totalMs,rolledBack,downloadSource]=process.argv.slice(1);let result={};try{result=JSON.parse(fs.readFileSync(file,"utf8"));}catch{};result.status=status;result.startedAt=startedAt;if(finishedAt)result.finishedAt=finishedAt;else delete result.finishedAt;if(url)result.url=url;else delete result.url;if(qrPath)result.qrPath=qrPath;else delete result.qrPath;if(error)result.error=error;else delete result.error;if(logTail)result.logTail=logTail;else delete result.logTail;if(stage)result.progress={stage,summary:summary||"",updatedAt:new Date().toISOString()};if(process.env.OPENBOT_INSTALL_COMMIT)result.commit=process.env.OPENBOT_INSTALL_COMMIT;if(downloadSource)result.downloadSource=downloadSource;else delete result.downloadSource;if(rolledBack==="true")result.rolled_back=true;else delete result.rolled_back;result.timings={downloadMs:Number(downloadMs)||0,deployMs:Number(deployMs)||0,restartMs:Number(restartMs)||0,totalMs:Number(totalMs)||0};fs.writeFileSync(file,JSON.stringify(result,null,2)+"\n");' "$tmp" "$status" "$started" "$finished" "$url" "$qr" "$error" "$tail_text" "$stage" "$summary" "${BOT_DOWNLOAD_MS:-0}" "${BOT_DEPLOY_MS:-0}" "${BOT_RESTART_MS:-0}" "${BOT_TOTAL_MS:-0}" "$rolled_back" "$download_source"
  mv -f "$tmp" "$BOT_RESULT_FILE"
}
bot_write_running_result() {
  bot_write_state running "$1" '' '' '' '' '' starting 'Installation worker started.'
}
bot_write_result() {
  bot_write_state "$1" "$2" "$3" "$4" "$5" "$6" "$7" "${BOT_PROGRESS_STAGE:-}" "${BOT_PROGRESS_SUMMARY:-}"
}
bot_write_progress() {
  BOT_PROGRESS_STAGE="$1" BOT_PROGRESS_SUMMARY="$2" bot_write_state running "${BOT_STARTED_AT:-$(bot_now)}" '' '' '' '' '' "$1" "$2"
}
bot_mark_stage() {
  local stage="$1" summary="$2" now="$(bot_epoch_ms)"
  if [[ -n "${BOT_STAGE_STARTED_MS:-}" ]]; then
    local elapsed=$((now - BOT_STAGE_STARTED_MS))
    case "${BOT_PROGRESS_STAGE:-}" in
      downloading) BOT_DOWNLOAD_MS="$elapsed" ;;
      deploying) BOT_DEPLOY_MS="$elapsed" ;;
      restarting) BOT_RESTART_MS="$elapsed" ;;
    esac
  fi
  BOT_STAGE_STARTED_MS="$now"
  BOT_PROGRESS_STAGE="$stage"
  BOT_PROGRESS_SUMMARY="$summary"
  bot_write_progress "$stage" "$summary"
}
bot_pid_running() {
  local pid="$(tr -d '[:space:]' <"$BOT_PID_FILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 1
  ps -p "$pid" -o args= 2>/dev/null | grep -F -- '--bot-mode-worker' >/dev/null
}
bot_print_status() {
  local brief=0
  [[ "${2:-}" == "--brief" ]] && brief=1
  if [[ ! -f "$BOT_RESULT_FILE" ]]; then
    printf '%s\n' '===== OPENBOT BOT RESULT =====' 'OPENBOT_STATUS=not-installed' "OPENBOT_RESULT_FILE=$BOT_RESULT_FILE" 'OPENBOT_BOT_INSTRUCTION=No detached OpenBot installation has been recorded yet. Run install.sh --bot-mode to start one.' '===== END OPENBOT BOT RESULT ====='
    return 0
  fi
  BOT_LOG_FILE="$BOT_LOG_FILE" OPENBOT_BOT_STATUS_BRIEF="$brief" node -e 'const fs=require("fs");const file=process.argv[1];let v;try{v=JSON.parse(fs.readFileSync(file,"utf8"));}catch{console.log("===== OPENBOT BOT RESULT =====\nOPENBOT_STATUS=failed\nOPENBOT_ERROR=Result file is not valid JSON.\nOPENBOT_RESULT_FILE="+file+"\n===== END OPENBOT BOT RESULT =====");process.exit(0);}const age=v.status==="running"&&v.startedAt?Date.now()-Date.parse(v.startedAt):0;const logPath=process.env.BOT_LOG_FILE||"the install log";const brief=process.env.OPENBOT_BOT_STATUS_BRIEF==="1";const lines=["===== OPENBOT BOT RESULT =====","OPENBOT_STATUS="+(v.status||"failed")];if(v.progress?.stage)lines.push("OPENBOT_PROGRESS_STAGE="+v.progress.stage);if(v.url)lines.push("OPENBOT_URL="+v.url);if(v.qrPath)lines.push("OPENBOT_QR_PATH="+v.qrPath);if(brief){if(v.status==="running"&&age>180000){lines.push("OPENBOT_WARNING=Installation exceeded 3 minutes; stop polling.");lines.push("OPENBOT_LOG_FILE="+logPath);let tail=v.logTail;try{tail=tail||fs.readFileSync(logPath,"utf8").split(/\r?\n/).slice(-20).join("\n");}catch{}if(tail)lines.push("OPENBOT_LOG_TAIL="+tail.replace(/\n/g,"\\n"));}if(v.status==="running")lines.push("OPENBOT_BOT_INSTRUCTION="+(age>180000?"Send the log tail to the user and stop polling.":"Relay the current stage to the user; poll --bot-status --brief no more than once more after 30-60 seconds."));else if(v.status==="success")lines.push("OPENBOT_BOT_INSTRUCTION=Send OPENBOT_URL and attach OPENBOT_QR_PATH as an image using the installed SendToUser tool.");else lines.push("OPENBOT_BOT_INSTRUCTION=Tell the user the installation failed and include the log path "+logPath+".");lines.push("===== END OPENBOT BOT RESULT =====");console.log(lines.join("\n"));process.exit(0);}lines.splice(2,0,"OPENBOT_RESULT_FILE="+file);if(v.startedAt)lines.push("OPENBOT_STARTED_AT="+v.startedAt);if(v.finishedAt)lines.push("OPENBOT_FINISHED_AT="+v.finishedAt);if(v.progress?.summary)lines.push("OPENBOT_PROGRESS_SUMMARY="+v.progress.summary);if(v.commit)lines.push("OPENBOT_COMMIT="+v.commit);if(v.downloadSource)lines.push("OPENBOT_DOWNLOAD_SOURCE="+v.downloadSource);if(v.timings)for(const k of ["downloadMs","deployMs","restartMs","totalMs"])if(Number.isFinite(v.timings[k]))lines.push("OPENBOT_TIMING_"+k.replace(/Ms$/,"").toUpperCase()+"_MS="+v.timings[k]);if(age>180000)lines.push("OPENBOT_WARNING=Installation exceeded 3 minutes; include the log tail and stop polling. Check "+logPath+".");if(v.error)lines.push("OPENBOT_ERROR="+v.error);if(v.logTail)lines.push("OPENBOT_LOG_TAIL="+v.logTail.replace(/\n/g,"\\n"));if(v.status==="running")lines.push("OPENBOT_BOT_INSTRUCTION="+(age>180000?"Send the log tail to the user and stop polling.":"Run install.sh --bot-status --brief again in 30-60 seconds; relay OPENBOT_PROGRESS_STAGE and OPENBOT_PROGRESS_SUMMARY to the user before the next poll, with no extra verification."));if(v.status==="success")lines.push("OPENBOT_BOT_INSTRUCTION=OpenBot is installed (commit "+(v.commit||"unknown")+"). Send OPENBOT_URL="+(v.url||"")+" to the user and attach OPENBOT_QR_PATH="+(v.qrPath||"")+" as an image using the installed SendToUser tool; do not expose secrets.");if(v.status==="failed")lines.push("OPENBOT_BOT_INSTRUCTION=Tell the user the installation failed; summarize OPENBOT_ERROR and OPENBOT_LOG_TAIL, include the log path "+logPath+", and retry install.sh --bot-mode. Do not claim success.");lines.push("===== END OPENBOT BOT RESULT =====");console.log(lines.join("\n"));' "$BOT_RESULT_FILE"
}
bot_worker_exit() {
  local code="$?"
  trap - EXIT
  if [[ "${BOT_WORKER_DONE:-0}" != "1" ]]; then
    BOT_TOTAL_MS="$(( $(bot_epoch_ms) - ${BOT_START_EPOCH_MS:-$(bot_epoch_ms)} ))"
    bot_write_result failed "${BOT_STARTED_AT:-$(bot_now)}" "$(bot_now)" '' '' "${BOT_FAILURE_ERROR:-OpenBot detached installation exited with code $code.}" "$(tail -n 20 "$BOT_LOG_FILE" 2>/dev/null || true)" || true
  fi
  rm -f "$BOT_PID_FILE"
  exit "$code"
}
install_main() {
local BOT_WORKER_MODE=0
[[ "${1:-}" == "--bot-mode-worker" ]] && BOT_WORKER_MODE=1
if [[ ! -f "$HOST" ]]; then
  if [[ "$BOT_WORKER_MODE" == "1" ]]; then
    # Some Grok Bot Computers keep the host at a different path. Reconcile
    # needs a real host file to back up and wrap, so an unusable --host-main
    # is fatal there (the EXIT trap records the failure). A plain install
    # keeps the long-standing refusal message.
    echo "OpenBot: host main file is missing ($HOST); bot-mode cannot reconcile." >&2
    exit 1
  fi
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
      if [[ "${BOT_WORKER_MODE:-0}" == "1" ]]; then
        curl --connect-timeout 5 --max-time 10 --retry 0 -fsSL \
          -H "Accept: application/vnd.github+json" \
          -H "User-Agent: openbot-install" \
          "https://api.github.com/repos/aaravarr/openbot/commits/main"
      else
        curl -fsSL \
          -H "Accept: application/vnd.github+json" \
          -H "User-Agent: openbot-install" \
          "https://api.github.com/repos/aaravarr/openbot/commits/main"
      fi \
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

if [[ "$BOT_WORKER_MODE" == "1" ]]; then
  bot_mark_stage downloading 'Fetching the OpenBot release into staging.'
fi
COMMIT="$(resolve_install_commit)"
export OPENBOT_INSTALL_COMMIT="$COMMIT"

DEPLOY_DIR="$DEST"
STAGING_DIR=""
if [[ "$BOT_WORKER_MODE" == "1" ]]; then
  STAGING_DIR="$DATA/openbot-staging"
  rm -rf "$STAGING_DIR"
  mkdir -p "$STAGING_DIR"
  DEPLOY_DIR="$STAGING_DIR"
fi
if [[ -n "${OPENBOT_SRC:-}" ]]; then
  if [[ "$BOT_WORKER_MODE" == "1" ]]; then
    cp -R "$OPENBOT_SRC"/. "$DEPLOY_DIR"
  else
    rm -rf "$DEST"
    mkdir -p "$DEST"
    cp -R "$OPENBOT_SRC"/. "$DEST"
  fi
else
  TMP="$(mktemp -d)"
  DOWNLOAD_SOURCE=""
  DOWNLOAD_ERRORS=()
  download_source() {
    local source="$1" url="$2" attempt http_code curl_code detail archive
    archive="$TMP/$source.tar.gz"
    for attempt in 1 2 3; do
      curl_code=0
      http_code="$(curl -sS -L -o "$archive" -w '%{http_code}' --connect-timeout 15 "$url" 2>"$TMP/$source.err")" || curl_code=$?
      if [[ "$curl_code" -eq 0 && "$http_code" =~ ^2[0-9][0-9]$ ]] && tar -xzf "$archive" -C "$TMP"; then
        DOWNLOAD_SOURCE="$source"
        return 0
      fi
      detail="HTTP ${http_code:-000}"
      [[ -s "$TMP/$source.err" ]] && detail="$detail: $(tr '\n' ' ' <"$TMP/$source.err")"
      echo "OpenBot: download source=$source attempt=$attempt failed ($detail)." >&2
      DOWNLOAD_ERRORS+=("$source=${http_code:-000}")
      [[ "${http_code:-000}" == 403 || "${http_code:-000}" == 429 ]] && break
      [[ "${http_code:-000}" =~ ^5[0-9][0-9]$ || "$curl_code" -ne 0 ]] || break
      sleep 2
    done
    return 1
  }
  TARBALL="$REPO_TARBALL"
  if [[ "$COMMIT" != "unknown" && "$REPO_TARBALL" == "$DEFAULT_TARBALL" ]]; then
    TARBALL="https://codeload.github.com/aaravarr/openbot/tar.gz/${COMMIT}"
  fi
  if ! download_source codeload "$TARBALL"; then
    if [[ "$REPO_TARBALL" == "$DEFAULT_TARBALL" || -n "${OPENBOT_ARCHIVE_TARBALL:-}" ]]; then
      download_source github-archive "$ARCHIVE_TARBALL" || true
    fi
  fi
  if [[ -z "$DOWNLOAD_SOURCE" ]]; then
    if [[ -d "$DEST" && -f "$DEST/package.json" ]]; then
      echo 'OpenBot: download failed; reused existing install.' >&2
      DOWNLOAD_SOURCE=existing-install
      BOT_FAILURE_ERROR="download failed; reused existing install"
      BOT_PROGRESS_SUMMARY="download failed; reused existing install"
      if [[ "$BOT_WORKER_MODE" == "1" ]]; then
        cp -a "$DEST"/. "$DEPLOY_DIR"/
      fi
    else
      DOWNLOAD_FAILURE_ERROR="OpenBot download failed: ${DOWNLOAD_ERRORS[*]}"
      echo "$DOWNLOAD_FAILURE_ERROR" >&2
      if [[ "${DOWNLOAD_ERRORS[*]}" =~ =[1-9][0-9][0-9] ]]; then
        BOT_FAILURE_ERROR="$DOWNLOAD_FAILURE_ERROR"
      else
        unset BOT_FAILURE_ERROR
      fi
      exit 1
    fi
  fi
  OPENBOT_DOWNLOAD_SOURCE="$DOWNLOAD_SOURCE"
  export OPENBOT_DOWNLOAD_SOURCE
  if [[ "${OPENBOT_TEST_DOWNLOAD_ONLY:-}" == "1" ]]; then
    BOT_TOTAL_MS="$(( $(bot_epoch_ms) - ${BOT_START_EPOCH_MS:-$(bot_epoch_ms)} ))"
    BOT_PROGRESS_STAGE=download BOT_PROGRESS_SUMMARY="${BOT_PROGRESS_SUMMARY:-Download source selected: $DOWNLOAD_SOURCE.}" bot_write_state success "${BOT_STARTED_AT:-$(bot_now)}" "$(bot_now)" '' '' '' '' download "${BOT_PROGRESS_SUMMARY:-Download source selected: $DOWNLOAD_SOURCE.}"
    BOT_WORKER_DONE=1
    exit 0
  fi
  if [[ "$DOWNLOAD_SOURCE" == "existing-install" ]]; then
    :
  elif [[ "$BOT_WORKER_MODE" == "1" ]]; then
    cp -a "$TMP"/openbot-*/. "$DEPLOY_DIR"/
  else
    rm -rf "$DEST"
    mv "$TMP"/openbot-* "$DEST"
  fi
  rmdir "$TMP" 2>/dev/null || true
fi

stamp_payload_version "$DEPLOY_DIR" "$COMMIT"

cd "$DEPLOY_DIR"
if [[ "$BOT_WORKER_MODE" == "1" ]]; then
  node --experimental-strip-types --check src/cli.ts
  node --check payload/runtime.cjs
  node --check payload/hop-server.cjs
fi

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
  [[ -f "$DEPLOY_DIR/payload/vendor/pngjs/package.json" && -f "$DEPLOY_DIR/payload/vendor/jpeg-js/package.json" ]]
}

warn_npm_install_failed() {
  {
    printf '%s\\n' '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
    printf '%s\\n' 'WARN: OpenBot could not npm-install the compression libraries.'
    printf '%s\\n' "      Reason: $1"
    if payload_vendor_compression_present; then
      printf '%s\\n' '      Bundled libs in payload/vendor/ cover this: image compression stays available.'
    else
      printf '%s\\n' '      No bundled libs found: image compression is DISABLED. The hop still'
      printf '%s\\n' '      routes, but oversized images degrade to omit placeholders.'
      printf '%s\\n' '      Remediation: give the box npm registry access (or set a mirror),'
      printf '%s\\n' '      then re-run this installer.'
    fi
    printf '%s\\n' '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
  } >&2
}

if [[ "$BOT_WORKER_MODE" == "1" ]]; then
  if [[ "${OPENBOT_DOWNLOAD_SOURCE:-}" == "existing-install" ]]; then
    bot_mark_stage deploying 'download failed; reused existing install'
  else
    bot_mark_stage deploying 'Release downloaded; preparing runtime dependencies.'
  fi
fi
if [[ "${OPENBOT_SKIP_NPM_INSTALL:-}" != "1" ]] && ! payload_vendor_compression_present; then
  NPM_FLAGS=(--omit=dev --no-audit --no-fund --loglevel=error)
  [[ "$BOT_WORKER_MODE" == "1" ]] && NPM_FLAGS+=(--prefer-offline)
  if ! command -v npm >/dev/null 2>&1; then
    warn_npm_install_failed "npm is not on PATH"
  elif ! npm install "${NPM_FLAGS[@]}" >/dev/null 2>&1 &&
    ! npm install "${NPM_FLAGS[@]}" --registry=https://registry.npmmirror.com >/dev/null 2>&1; then
    warn_npm_install_failed "the default npm registry and registry.npmmirror.com both failed"
  fi
fi
if [[ "$BOT_WORKER_MODE" == "1" ]]; then
  staging_swap() {
    local previous="$DATA/openbot-previous"
    (
      set -euo pipefail
      local old_release_moved=0
      staging_swap_exit() {
        local code="$?"
        trap - EXIT
        if [[ "$code" -ne 0 && "$old_release_moved" -eq 1 && ! -e "$DEST" && -e "$previous" ]]; then
          if mv -T "$previous" "$DEST" || mv -T "$previous" "$DEST"; then
            bot_write_state failed "${BOT_STARTED_AT:-$(bot_now)}" "$(bot_now)" '' '' 'Staging switch failed; the previous release was rolled back successfully.' '' swapping 'Staging switch failed; rolled back to the previous release.' true || true
          else
            bot_write_state failed "${BOT_STARTED_AT:-$(bot_now)}" "$(bot_now)" '' '' 'Staging switch failed and the rollback could not restore the previous release.' '' swapping 'Staging switch failed; rollback was attempted but did not complete.' true || true
          fi
        fi
        exit "$code"
      }
      trap staging_swap_exit EXIT
      rm -rf "$previous"
      if [[ -e "$DEST" || -L "$DEST" ]]; then
        mv -T "$DEST" "$previous"
        old_release_moved=1
      fi
      mv -T "$STAGING_DIR" "$DEST"
      trap - EXIT
    )
  }
  if ! staging_swap; then
    # The swap function has already persisted the rollback result. Do not let
    # the worker EXIT trap overwrite it or continue into reconcile/tunnel.
    BOT_WORKER_DONE=1
    exit 1
  fi
  cd "$DEST"
  bot_mark_stage restarting 'Staging is warm; switching the new release into place.'
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
  if [[ ! -f "$HOST" ]]; then
    # The daemon pid is live but the recorded host path is unusable on this
    # box, so the cli-based stop would refuse. Killing the recorded pid and
    # clearing the pidfile is the same outcome without depending on $HOST.
    kill "$pid" 2>/dev/null || true
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
if [[ "$BOT_WORKER_MODE" == "1" ]]; then
  bot_write_progress restarting 'Release is active; stopping old workers and reconciling once.'
fi
stop_old_guard_for_update || true
stop_stale_hop_for_update || true

node --experimental-strip-types src/cli.ts install --host-main "$HOST" --sand-data "$DATA"
if [[ "$BOT_WORKER_MODE" == "1" ]]; then
  bot_mark_stage tunnel 'The host is ready; ensuring the tunnel stays available.'
fi

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
    bot_write_progress tunnel "Tunnel attempt ${BOT_ATTEMPT}/3."
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
  BOT_TOTAL_MS="$(( $(bot_epoch_ms) - ${BOT_START_EPOCH_MS:-$(bot_epoch_ms)} ))"
  BOT_PROGRESS_STAGE=qr BOT_PROGRESS_SUMMARY='Tunnel is ready; QR code generated.' bot_write_state success "$BOT_STARTED_AT" "$(bot_now)" "$BOT_URL" "$BOT_QR_PATH" "" "" qr 'Tunnel is ready; QR code generated.'
  BOT_WORKER_DONE=1

  cat <<EOF

===== OPENBOT BOT RESULT =====
OPENBOT_URL=$BOT_URL
OPENBOT_QR_PATH=$BOT_QR_PATH
OPENBOT_COMMIT=$COMMIT
OPENBOT_BOT_INSTRUCTION=OpenBot is installed (commit $COMMIT). Send OPENBOT_URL=$BOT_URL to the user and attach OPENBOT_QR_PATH=$BOT_QR_PATH as an image using the installed SendToUser tool; do not expose secrets.
===== END OPENBOT BOT RESULT =====
EOF
fi

}
if [[ "${1:-}" == "--bot-status" ]]; then
  bot_print_status "$@"
  exit 0
fi
if [[ "${1:-}" == "--bot-mode" ]]; then
  mkdir -p "$DATA"
  if bot_pid_running; then
    printf '%s\n' '===== OPENBOT BOT RESULT =====' 'OPENBOT_STATUS=started' "OPENBOT_RESULT_FILE=$BOT_RESULT_FILE" "OPENBOT_LOG_FILE=$BOT_LOG_FILE" 'OPENBOT_BOT_INSTRUCTION=SendToUser now: installation has started and should finish in about 15-60 seconds. Then poll --bot-status --brief at most twice, 30-60 seconds apart; do not run extra verification.' '===== END OPENBOT BOT RESULT ====='
    exit 0
  fi
  rm -f "$BOT_PID_FILE"
  BOT_STARTED_AT="$(bot_now)"
  BOT_START_EPOCH_MS="$(bot_epoch_ms)"
  export BOT_RESULT_FILE BOT_LOG_FILE BOT_PID_FILE BOT_STARTED_AT BOT_START_EPOCH_MS
  bot_write_running_result "$BOT_STARTED_AT"
  # The worker runs this same file in a child shell. It needs the config
  # variables (HOST, DATA, ...) that install_main reads, the bot_* helper
  # functions, and BOT_WORKER_DONE=1 semantics inside bot_worker_exit.
  export HOST DATA DEST DEFAULT_TARBALL REPO_TARBALL DEFAULT_ARCHIVE_TARBALL ARCHIVE_TARBALL NODE_DIST NODE_VERSION
  export -f bot_now bot_epoch_ms bot_write_state bot_write_running_result bot_write_result bot_write_progress bot_mark_stage bot_pid_running bot_print_status bot_worker_exit install_main
  (setsid nohup bash -euo pipefail -c 'trap bot_worker_exit EXIT; BOT_WORKER_DONE=0; install_main --bot-mode-worker' </dev/null >>"$BOT_LOG_FILE" 2>&1) &
  printf '%s\n' "$!" >"${BOT_PID_FILE}.tmp"
  mv -f "${BOT_PID_FILE}.tmp" "$BOT_PID_FILE"
  printf '%s\n' '===== OPENBOT BOT RESULT =====' 'OPENBOT_STATUS=started' "OPENBOT_RESULT_FILE=$BOT_RESULT_FILE" "OPENBOT_LOG_FILE=$BOT_LOG_FILE" 'OPENBOT_BOT_INSTRUCTION=SendToUser now: installation has started and should finish in about 15-60 seconds. Then poll --bot-status --brief at most twice, 30-60 seconds apart; do not run extra verification.' '===== END OPENBOT BOT RESULT ====='
  exit 0
fi
if [[ "${1:-}" == "--bot-mode-worker" ]]; then
  # Foreground worker runs (direct --bot-mode-worker invocation) previously
  # had no EXIT trap, so any failure left the result file at running. Attach
  # the same trap the detached child uses so every failure path records
  # status=failed before the process exits.
  BOT_STARTED_AT="$(bot_now)"
  BOT_START_EPOCH_MS="$(bot_epoch_ms)"
  export BOT_RESULT_FILE BOT_LOG_FILE BOT_PID_FILE BOT_STARTED_AT BOT_START_EPOCH_MS
  trap bot_worker_exit EXIT
fi
install_main "$@"
