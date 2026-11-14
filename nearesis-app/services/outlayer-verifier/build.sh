#!/bin/sh
# Mirrors the official outlayer-cli `basic` template build (wasm32-wasip2),
# plus path remapping so the artifact hash does not depend on where it is built.
set -e
cd "$(dirname "$0")"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$(pwd)=/build --remap-path-prefix=$CARGO_HOME_DIR=/cargo"
export SOURCE_DATE_EPOCH=0
cargo build --target wasm32-wasip2 --release --locked
mkdir -p out
cp target/wasm32-wasip2/release/nearesis-verifier.wasm out/
shasum -a 256 out/nearesis-verifier.wasm
