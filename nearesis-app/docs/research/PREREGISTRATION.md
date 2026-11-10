# Preregistration (DRAFT skeleton, not frozen)

> **Status: DRAFT.** Nothing here is registered. No hash has been committed to any chain. Freezing requires the owner, the final hypothesis text and (for final publication) a NEAR mainnet commitment made before the designated holdout evaluation (Build Bible ch.02, ch.00). If ordering cannot be honestly established, label the study `post-hoc registration`. A timestamp alone does not prove data was unseen.

## Base vs NEAR mainnet ambiguity statement

The instruction "minimal base net test" is ambiguous. The required release gate is a minimal NEAR **mainnet** smoke test after testnet integration passes, because the product targets NEAR and the original idea calls for a NEAR mainnet preregistration hash. A separate Base L2 adapter (chain ID 8453) is part of the plugin design and may run a read-only Base mainnet query test, but it is **not** substituted for NEAR mainnet acceptance. The two actions are labeled separately in release manifests. This interpretation must appear in every deployment checklist. (Build Bible ch.00.)

## Fields to freeze (fill in before registration)

| Field                       | Value                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hypothesis                  | TBD                                                                                                                                                                                |
| Primary outcome             | TBD (candidates in ch.02: 1-, 7-, 14-day future daily successful actions, unique active signer proxies, contract diversity, application-tagged activity, each reported separately) |
| Source cut-off (UTC)        | TBD                                                                                                                                                                                |
| Sample inclusion rules      | TBD (exclude Intents-generated actions from predictor and target)                                                                                                                  |
| Treatment of missing dates  | TBD (never convert missing to zero)                                                                                                                                                |
| Test family                 | TBD                                                                                                                                                                                |
| Forecast horizon(s)         | TBD                                                                                                                                                                                |
| Benchmark                   | TBD (model A: usage and seasonality; B: plus lagged Intents volume; C: plus lagged price returns; D: both)                                                                         |
| Loss function               | TBD (MAE, sMAPE with zero-handling rule, bias)                                                                                                                                     |
| Minimum effect              | TBD                                                                                                                                                                                |
| Confidence reporting        | TBD (intervals, number of forecast origins)                                                                                                                                        |
| Multiple-comparison control | Benjamini-Hochberg FDR on pre-specified families                                                                                                                                   |
| Evaluation design           | Rolling-origin with temporally separated lockbox; no random cross-validation                                                                                                       |
| Data-availability limit     | Public chain data is incomplete after the Oct 27 private-settlement transition (ch.14)                                                                                             |

## Freeze procedure (not yet executed)

1. Final document reviewed by the owner.
2. Canonical UTF-8 SHA-256 computed and recorded.
3. Development: hash written in a NEAR testnet transaction, read back.
4. Final: hash committed on NEAR mainnet after all testnet gates and before the locked-holdout evaluation, with explicit human approval.

Claims remain non-causal: significance is not evidence that Intents causes adoption.
