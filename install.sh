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

exec node --experimental-strip-types src/cli.ts install --host-main "$HOST" --sand-data "$DATA"
