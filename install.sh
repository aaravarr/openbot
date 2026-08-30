#!/usr/bin/env bash
# OpenBot one-line installer. Run this on the Grok Bot Computer, not on a Mac.
set -euo pipefail

HOST="${OPENBOT_HOST_MAIN:-/home/box/sand-host/host-main.cjs}"
DATA="${OPENBOT_SAND_DATA:-/home/box/sand-data}"
DEST="${OPENBOT_DEST:-$DATA/openbot}"
REPO_TARBALL="${OPENBOT_TARBALL:-https://codeload.github.com/aaravarr/openbot/tar.gz/refs/heads/main}"

if [[ ! -f "$HOST" ]]; then
  echo "OpenBot installs on the Grok Bot Computer. Missing $HOST." >&2
  echo "Do not run this script on a Mac. A laptop hop never sees a Bot turn." >&2
  exit 1
fi

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
