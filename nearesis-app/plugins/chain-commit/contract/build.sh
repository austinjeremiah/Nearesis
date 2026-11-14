#!/bin/sh
# Reproducible: wasm-tools parse is deterministic. Prints the sha256 of the artifact that is deployed.
set -e
cd "$(dirname "$0")"
mkdir -p out
wasm-tools parse commit.wat -o out/commit.wasm
wasm-tools validate out/commit.wasm
shasum -a 256 out/commit.wasm
wc -c out/commit.wasm
