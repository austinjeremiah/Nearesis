# Verification: B05, B12, B13, Q21 (2026-11-12)

Commit under test: 27c6bbf (working tree has other agents' uncommitted files; none of the four tests' inputs were modified here).
Why re-verified: B05, B12 and B13 were STALE in the latest conformance report because `tests/integration/lib/research.ts` changed after their evidence. No code was changed; all four tests pass unmodified. Criteria are the chapter 16b definitions, unchanged. `NEARESIS_ACCEPT_OUT` was not set and `pnpm accept` was not run, so no evidence file was written; the lead records evidence.

Each test's assertions encode the PASS criteria; a pass means every assertion held.

## B05 golden trace
Command: `npx vitest run tests/integration/B05.accept.test.ts --maxWorkers=2 --no-file-parallelism` (1 passed, 127 s).
- (a) 12 ordered step records with component, hashes, times, mode, evidence link, schema valid: PASS.
- (b) output hash of each step equals the next dependent step's input hash (tampered chain rejected with `continuity`): PASS.
- (c) mock only on inference/attestation components, none on data or semantic steps: PASS.
- (d) Explorer-401 run reports `reason_code` on acquire and marks dependent steps blocked (8 dependent steps `UPSTREAM_NOT_COMPLETED`, not completed); swallowed failure rejected: PASS.
- (e) negative control (mocked acquire) detected as `mock_not_allowed` and the verdict fails: PASS.
Known recorded fact: step 12 is recorded blocked (BLK-20261110-003, no testnet signing).

## B12 cross-agent numeric consistency
Command: `npx vitest run tests/integration/B12.accept.test.ts --maxWorkers=2 --no-file-parallelism` (1 passed).
- (a) all children carry the same question hash, snapshotId, metricVersionMap hash and preregistration hash: PASS.
- (b) headline verdict and delta MAE agree across the 6 artifacts (engine output, research_run.json, capsule results, evidence graph node, THESIS.md, memo.pdf); cached older result fails (b): PASS.
- (c) a child with a different question, snapshot, metric-version-map or preregistration hash is refused at dispatch (4 of 4 `CONTEXT_MISMATCH`, no task rows); stale artifact excluded: PASS.
- (d) the disagreement yields an explicit conflict record naming its source: PASS.

## B13 claims within data limits
Command: `npx vitest run tests/integration/B13.accept.test.ts --maxWorkers=2 --no-file-parallelism` (1 passed).
- (a) 0 forbidden-class matches across exports, memo, persisted panels and agent findings: PASS.
- (b) required labels present (dry quote, sampled at; provider-reported 1Click, not all Intents; not observable after 2026-10-27; mode and date); a template dropping the quote caveat fails: PASS.
- (c) 6 of 6 seeded forbidden claims blocked at the publication gate: PASS.
- (d) a missing label names the panel id: PASS.

## Q21 quant isolation
Command: `cd services/research && npx vitest run test/acceptance/Q21.accept.test.ts --maxWorkers=2` (1 passed). The python case was also run directly (`PYTHONPATH=services/research uv run python -m nearesis_research.accept_cases_g07 Q21`) to confirm it was not in the `blocked` path: `blocked` is None; container node:24-bookworm-slim, network none, read-only rootfs, user 65534, memory 128 MB.
- (a) egress fails, canary absent from env and filesystem, snapshot digest equal; the network-enabled control connects (so it would FAIL): PASS.
- (b) memory probe `memory_budget_exceeded`, loop probe `time_budget_exceeded`, no output promoted: PASS.
- (c) 5 code-bearing manifests (python key, source key, code in params, nested code, unknown kind) rejected with 422, runner invoked 0 times; declarative manifest accepted (202): PASS.
- (d) corrupted, truncated and unlisted outputs refused promotion; the normal set promoted: PASS.
- (e) worker uid 65534, not root: PASS.

## Blockers
None for these four tests. `tests/integration/lib/research.ts` and `lib/browser.ts` were not changed. No INTEGRATION_QUEUE entries were needed.
