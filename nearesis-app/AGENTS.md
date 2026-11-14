# AGENTS.md (nearesis-app): entrypoint for coding agents

Read before coding:

- Build Bible: `../NEARESIS_Build_Bible/BUILD_BIBLE.md` and its `AGENTS.md`; chapters 00, 03, 04, 15, 16, 18, 28 and your phase chapter.
- Status: `../NEARESIS_Build_Bible/reports/INDEX.md` (only the Engine A lead edits it).
- Contracts: `packages/contracts` (frozen; propose changes in `../NEARESIS_Build_Bible/coordination/INTEGRATION_QUEUE.md`).
- Ownership: `../NEARESIS_Build_Bible/coordination/OWNERSHIP_MATRIX.md` (one writer per path).
- Rules for subagents: `../NEARESIS_Build_Bible/coordination/PROMPTS/_COMMON_RULES.md` (including the concurrency rules).
- Security: `docs/security/THREAT_MODEL.md`. DB: `docs/architecture/DATABASE_CONVENTIONS.md`. Sources: `docs/refs/source-register.yaml`.

## Commands (always `source scripts/toolchain-env.sh` first)

| Purpose               | Command                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Install               | `pnpm install --frozen-lockfile` and `uv sync --frozen`            |
| Typecheck, lint, test | `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm quality:all`     |
| Format                | `pnpm exec prettier --write <your paths>` (never at the repo root) |
| Python tests          | `uv run pytest`                                                    |
| Secrets scan          | `pnpm security:secrets`                                            |
| URL audit             | `pnpm security:urls`                                               |
| Local stack           | `pnpm dev:infra` (never `down -v`)                                 |
| Acceptance            | `pnpm accept --id <ID> --session <agentId>` after committing       |
| Status                | `pnpm coord ...` (see `scripts/coord.ts`)                          |

## Forbidden

- Printing, logging or committing secret values; committing `.env`.
- Marking a test PASS by hand or editing evidence JSON; fabricating outputs.
- Assuming API schemas: verify against official docs and record in the source register (`TO_VERIFY` until confirmed).
- `eval`, `new Function`, unrestricted SQL, arbitrary agent-generated React or JSX.
- Mainnet writes, paid external actions, or privileged-tool/secret changes without explicit human approval.
- Executing swaps (1Click calls use `dry: true`); treating missing data as zero; claiming complete on-chain observability after the private-settlement transition.
- Editing files you do not own; `git reset`, stash, rebase, branch switches, `git add -A`; phase numbers or AI attribution in commit messages.
- Network egress to hosts not in the source register.
