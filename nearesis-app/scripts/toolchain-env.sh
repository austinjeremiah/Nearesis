# Project-local toolchain for nearesis-app. Usage (from any dir):
#   source nearesis-app/scripts/toolchain-env.sh
# Puts Node 24.22.2, pnpm (via corepack), uv and uv-managed CPython 3.12 first on PATH
# for this shell only. Nothing system-wide is changed. Bootstrap: scripts/bootstrap-toolchain.sh
_ne_root="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")/.." && pwd)"
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
