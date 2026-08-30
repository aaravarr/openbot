#!/usr/bin/env bash
# OpenBot one-line installer. Run this on the Grok Bot Computer, not on a Mac.
set -euo pipefail

HOST="${OPENBOT_HOST_MAIN:-/home/box/sand-host/host-main.cjs}"
DATA="${OPENBOT_SAND_DATA:-/home/box/sand-data}"
DEST="${OPENBOT_DEST:-$DATA/openbot}"
REPO_TARBALL="${OPENBOT_TARBALL:-https://codeload.github.com/aaravarr/openbot/tar.gz/refs/heads/main}"
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

if [[ -n "${OPENBOT_SRC:-}" ]]; then
  rm -rf "$DEST"
  mkdir -p "$DEST"
  cp -R "$OPENBOT_SRC"/. "$DEST"
else
  TMP="$(mktemp -d)"
  curl -fsSL "$REPO_TARBALL" | tar -xz -C "$TMP"
  rm -rf "$DEST"
  mv "$TMP"/openbot-* "$DEST"
  rmdir "$TMP" 2>/dev/null || true
fi

cd "$DEST"
exec node --experimental-strip-types src/cli.ts install --host-main "$HOST" --sand-data "$DATA"
