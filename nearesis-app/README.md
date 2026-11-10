# nearesis-app

Application workspace for Nearesis (pnpm monorepo plus a uv Python project). Specification and evidence live in `../NEARESIS_Build_Bible`.

## Bootstrap from a clean checkout

Requires `git`, `curl`, Docker (for the local stack). Node, pnpm, uv and Python 3.12 are installed project-locally; nothing system-wide changes.

```sh
git clone <repo> && cd <repo>/nearesis-app
sh scripts/bootstrap-toolchain.sh      # downloads checksum-verified Node 24.22.2, uv 0.13.7, CPython 3.12 into .toolchain/
. scripts/toolchain-env.sh             # puts them on PATH for this shell
pnpm install --frozen-lockfile
uv sync --frozen
pnpm typecheck && pnpm lint
pnpm dev:infra                         # Postgres 55432, Redis 56379, ClickHouse 58123/59000, Temporal 57233/58233 (127.0.0.1 only)
pnpm security:all                      # secret scan and source-register URL audit
uv run pytest
```

Secrets go in the repo-root `.env` (gitignored); never commit it. See `AGENTS.md` for rules and `docs/` for the threat model, database conventions and source register.
