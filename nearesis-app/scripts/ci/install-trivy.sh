#!/bin/sh
# Installs the pinned trivy binary into .toolchain/bin. The release tarball is downloaded from the pinned GitHub release and its
# sha256 must equal the value committed in scripts/release/trivy.lock.json, otherwise nothing is installed. POSIX sh only.
set -eu
APP="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$APP/.toolchain/bin"
LOCK="$APP/scripts/release/trivy.lock.json"
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
field() { node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=process.argv[2].split(".");console.log(p.reduce((o,k)=>o?.[k],l)??"")' "$LOCK" "$1"; }
VERSION="$(field version)"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET="Linux-64bit"; PLAT="" ;;
  Darwin-arm64) ASSET="macOS-ARM64"; PLAT="darwin-arm64" ;;
  Darwin-x86_64) ASSET="macOS-64bit"; PLAT="" ;;
  *) echo "install-trivy: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
# an already-installed binary is accepted only when its hash is a pinned one
if [ -x "$BIN/trivy" ] && [ -n "$PLAT" ]; then
  want="$(field "binarySha256.$PLAT")"
  if [ -n "$want" ] && [ "$(sha "$BIN/trivy")" = "$want" ]; then echo "install-trivy: pinned trivy $VERSION already present"; exit 0; fi
fi
EXPECT="$(field "releaseTarballSha256.$ASSET")"
[ -n "$EXPECT" ] || { echo "install-trivy: no pinned checksum for $ASSET" >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/trivy.tgz" "https://github.com/aquasecurity/trivy/releases/download/v$VERSION/trivy_${VERSION}_$ASSET.tar.gz"
GOT="$(sha "$TMP/trivy.tgz")"
if [ "$GOT" != "$EXPECT" ]; then echo "install-trivy: checksum mismatch for $ASSET (got $GOT, pinned $EXPECT)" >&2; exit 1; fi
mkdir -p "$BIN" "$TMP/x"
tar -xzf "$TMP/trivy.tgz" -C "$TMP/x" trivy
mv "$TMP/x/trivy" "$BIN/trivy"
chmod 0755 "$BIN/trivy"
echo "install-trivy: installed trivy $VERSION ($ASSET), tarball sha256 verified"
