#!/bin/sh
# Downloads checksum-verified, project-local Node + uv into nearesis-app/.toolchain (gitignored),
# then installs CPython 3.12 via uv and the pnpm shim via corepack. Idempotent.
set -eu
NODE_VERSION=v24.22.2   # Bible ch.15/28: Node >= 24.22.1
UV_VERSION=0.13.7
PY_VERSION=3.12         # Bible: Python 3.12+
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; T="$ROOT/.toolchain"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) NODE_PLAT=darwin-arm64; UV_PLAT=aarch64-apple-darwin ;;
  Darwin-x86_64) NODE_PLAT=darwin-x64; UV_PLAT=x86_64-apple-darwin ;;
  Linux-x86_64) NODE_PLAT=linux-x64; UV_PLAT=x86_64-unknown-linux-gnu ;;
  Linux-aarch64) NODE_PLAT=linux-arm64; UV_PLAT=aarch64-unknown-linux-gnu ;;
  *) echo "unsupported platform" >&2; exit 1 ;;
esac
mkdir -p "$T/dl" "$T/bin"; cd "$T/dl"
if [ "$("$T/node/bin/node" -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  F="node-$NODE_VERSION-$NODE_PLAT.tar.xz"
  curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/$F"
  curl -fsSL -o SHASUMS256.txt "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  grep " $F\$" SHASUMS256.txt | shasum -a 256 -c -
  rm -rf "$T/node"; tar -xJf "$F" -C "$T"; mv "$T/node-$NODE_VERSION-$NODE_PLAT" "$T/node"
fi
if ! "$T/bin/uv" --version 2>/dev/null | grep -q "uv $UV_VERSION"; then
  U="uv-$UV_PLAT.tar.gz"
  curl -fsSLO "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$U"
  curl -fsSL -o "$U.sha256" "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$U.sha256"
  shasum -a 256 -c "$U.sha256"
  tar -xzf "$U" -C "$T/bin" --strip-components=1
fi
. "$ROOT/scripts/toolchain-env.sh"
uv python install "$PY_VERSION"
corepack enable --install-directory "$T/bin" pnpm
node -v; uv --version; uv python find "$PY_VERSION"
