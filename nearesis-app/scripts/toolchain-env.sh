# Project-local toolchain for nearesis-app. Usage (from any dir):
#   source nearesis-app/scripts/toolchain-env.sh
# Puts Node 24.22.2, pnpm (via corepack), uv and uv-managed CPython 3.12 first on PATH
# for this shell only. Nothing system-wide is changed. Bootstrap: scripts/bootstrap-toolchain.sh
# Locate this file portably (bash, zsh, POSIX sh/dash). Shell-specific syntax is kept inside eval so dash never
# parses it. POSIX sh cannot report a sourced file's path, so callers there set NEARESIS_APP_ROOT first, or we fall
# back to searching upward from $PWD for scripts/toolchain-env.sh.
if [ -n "${NEARESIS_APP_ROOT:-}" ] && [ -f "$NEARESIS_APP_ROOT/scripts/toolchain-env.sh" ]; then
  _ne_root="$NEARESIS_APP_ROOT"
else
  _ne_src=""
  if [ -n "${BASH_VERSION:-}" ]; then eval '_ne_src="${BASH_SOURCE[0]}"'
  elif [ -n "${ZSH_VERSION:-}" ]; then eval '_ne_src="${(%):-%x}"'
  fi
  if [ -n "$_ne_src" ]; then
    _ne_root="$(cd "$(dirname "$_ne_src")/.." && pwd)"
  else
    _ne_root="$PWD"
    while [ "$_ne_root" != "/" ] && [ ! -f "$_ne_root/scripts/toolchain-env.sh" ]; do _ne_root="$(dirname "$_ne_root")"; done
  fi
  unset _ne_src
fi
export NEARESIS_APP_ROOT="$_ne_root"
export NEARESIS_TOOLCHAIN="$_ne_root/.toolchain"
export UV_PYTHON_INSTALL_DIR="$NEARESIS_TOOLCHAIN/python"
export UV_CACHE_DIR="$NEARESIS_TOOLCHAIN/uv-cache"
export UV_TOOL_DIR="$NEARESIS_TOOLCHAIN/uv-tools"
export UV_PYTHON_PREFERENCE=only-managed
export COREPACK_HOME="$NEARESIS_TOOLCHAIN/corepack"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export PATH="$NEARESIS_TOOLCHAIN/bin:$NEARESIS_TOOLCHAIN/node/bin:$PATH"
[ -d "$_ne_root/.venv/bin" ] && export PATH="$_ne_root/.venv/bin:$PATH"
unset _ne_root
