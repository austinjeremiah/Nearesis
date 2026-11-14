# Threat model (P00 baseline)

Source: Build Bible ch.12 (`NEARESIS_Build_Bible/chapters/12_SECURITY_PRIVACY_TRUST.md`). Controls are planned unless a test ID is recorded as PASS in `NEARESIS_Build_Bible/reports/TESTS/`. This file does not claim any control is implemented.

## Assets

| Asset                                                            | Sensitivity        | Notes                                                   |
| ---------------------------------------------------------------- | ------------------ | ------------------------------------------------------- |
| Secrets (`.env`, Partner JWT, API keys, NEAR keys, GCP identity) | High               | Never committed, logged or sent to a model              |
| Payment balances and chain keys (testnet, mainnet)               | High               | Mainnet only for a hash commitment, with human approval |
| Tenant data (workspaces, drafts, prompts, evidence)              | Medium to High     | Findings may be public; drafts are private              |
| Raw source archive and evidence chain                            | Integrity-critical | Content-addressed, immutable                            |
| Semantic model and query gateway                                 | Integrity-critical | Wrong metric or unbounded query = wrong claim or cost   |
| BigQuery spend                                                   | Financial          | Dry-run and billed-byte caps                            |

## Adversaries

Malicious user; compromised model response; prompt-injected web, docs or token metadata; compromised third-party plugin; stolen Partner JWT; tenant-crossing query bug; replayed workflow call; fraudulent attestation; malicious webhook; accidental high-cost BigQuery query or chain write.

## Trust boundaries, controls and tests

| Boundary                     | Control                                                                                      | Attack prevented                                      | Test IDs            |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------- |
| Repository -> anywhere       | Git-tracked secret scanner (`pnpm security:secrets`), `.env` gitignored                      | Committed credentials                                 | BOOT02              |
| Repository -> integrations   | Source register and URL auditor (`pnpm security:urls`)                                       | Undocumented endpoints                                | BOOT03              |
| API -> kernel                | Typed command ACL, Postgres RLS under `nearesis_app` (NOSUPERUSER, NOBYPASSRLS)              | Cross-tenant read or write                            | K01, K04, A17       |
| Plugin install -> worker     | Signature verification before spawn; missing signature rejected in production                | Malicious plugin                                      | K05                 |
| Source -> normalize          | Schema, checksum, quarantine; content-addressed immutable raw archive; no secrets in archive | Poisoned or tampered data, credential leakage         | D14                 |
| Offline replay               | Replay with credentials unset and egress denied                                              | Hidden network or credential dependence               | D15                 |
| Query -> Cube                | Strict AST validation; server-bound tenant/security context; cost bounds                     | SQL injection, runaway billing, client-forged tenancy | S14                 |
| Semantic discovery and cache | Cache keys carry scope, ACL, version, vintage                                                | Cross-scope leakage via cache or discovery            | S16                 |
| Agent -> tool proxy          | Leased capabilities, deny-by-default; external text is data                                  | Prompt injection, tool misuse, secret export          | A09                 |
| Agent memory                 | Workspace and role scoped recall, RLS                                                        | Cross-workspace memory leak                           | A17                 |
| Canvas spec -> browser       | Declarative schema only; arbitrary JSX rejected                                              | Code execution from agent output                      | C02                 |
| Labels, tooltips, markdown   | Inert text, CSP, no formatter functions                                                      | XSS                                                   | C10                 |
| Tool proxy -> internet       | Allowlisted egress, SSRF filter                                                              | Metadata-service token theft                          | SEC02               |
| Testnet -> mainnet           | Release gate plus human approval                                                             | Unexpected paid or wallet action                      | (G11 release tests) |

## Standing rules (from ch.12 and AGENTS.md)

- No `eval` or `new Function`; no unrestricted SQL from user or agent input; parameterized queries only.
- A TEE attestation is never equated with correctness of a third-party source; never mark VERIFIED without cryptographic verification.
- Pinned container digests (compose) and lockfiles; no `latest` in production.
- Security release blockers (tenant leak, public secret, uncontrolled mainnet action, unsupported TEE proof marked verified, arbitrary code execution from CanvasSpec, unbounded agent spawn, unauthorized plugin egress) are NO GO. An AI agent cannot waive them.

## Known gaps at P00

- Scanner covers git-tracked files and `.env` values of 8+ characters only; history rewriting or untracked files are out of scope.
- No remote CI yet (BLK-20261110-004).
