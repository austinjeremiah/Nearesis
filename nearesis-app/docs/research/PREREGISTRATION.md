# Preregistration (fixture-evaluation parameters frozen; chain commitment not made)

> **Status: the analysis parameters in the block below are FROZEN for fixture evaluation (see `PREREGISTRATION.freeze.json` for the canonical hash and freeze time). No hash has been committed to any chain. Freezing requires the owner, the final hypothesis text and (for final publication) a NEAR mainnet commitment made before the designated holdout evaluation (Build Bible ch.02, ch.00). If ordering cannot be honestly established, label the study `post-hoc registration`. A timestamp alone does not prove data was unseen.

## Base vs NEAR mainnet ambiguity statement

The instruction "minimal base net test" is ambiguous. The required release gate is a minimal NEAR **mainnet** smoke test after testnet integration passes, because the product targets NEAR and the original idea calls for a NEAR mainnet preregistration hash. A separate Base L2 adapter (chain ID 8453) is part of the plugin design and may run a read-only Base mainnet query test, but it is **not** substituted for NEAR mainnet acceptance. The two actions are labeled separately in release manifests. This interpretation must appear in every deployment checklist. (Build Bible ch.00.)

## Frozen analysis parameters (G07, Q11 to Q22)

Every confidence-interval method and level, minimum sample size and origin count, binomial and coverage band, model-selection rule, verdict table, robustness variant, test family and simulation seed used by Q11 to Q22 is in the block below and nowhere else. Tests read each value from this block through `nearesis_research.frozen` and fail if a value is absent, was changed after the freeze, or is supplied by the test. Canonicalisation for the document hash: CRLF and lone CR to LF, Unicode NFC, UTF-8, trailing whitespace preserved. Accent check text for the normalisation test: Šidák, café, naïve.

<!-- frozen-parameters:begin -->

```json
{
  "schemaVersion": 1,
  "experiment": {
    "horizons": [1, 7, 14],
    "primaryHorizon": 1,
    "primaryCandidate": "intents",
    "lagGrid": [0, 1, 2, 3, 4, 5, 7],
    "minTrain": 60,
    "lockboxDays": 30,
    "regimeSplit": "2026-10-27",
    "testFamily": [
      {
        "candidate": "intents",
        "horizon": 1,
        "versus": "baseline"
      },
      {
        "candidate": "price",
        "horizon": 1,
        "versus": "baseline"
      },
      {
        "candidate": "combined",
        "horizon": 1,
        "versus": "baseline"
      },
      {
        "candidate": "intents",
        "horizon": 7,
        "versus": "baseline"
      },
      {
        "candidate": "price",
        "horizon": 7,
        "versus": "baseline"
      },
      {
        "candidate": "combined",
        "horizon": 7,
        "versus": "baseline"
      },
      {
        "candidate": "intents",
        "horizon": 14,
        "versus": "baseline"
      },
      {
        "candidate": "price",
        "horizon": 14,
        "versus": "baseline"
      },
      {
        "candidate": "combined",
        "horizon": 14,
        "versus": "baseline"
      }
    ],
    "fdr": {
      "method": "benjamini_hochberg",
      "q": 0.05
    },
    "thresholds": {
      "minRelativeImprovement": 0.02,
      "minDevOrigins": 60,
      "minHoldoutOrigins": 14,
      "bootstrap": {
        "n": 500,
        "block": 7,
        "level": 0.95
      },
      "placebo": {
        "n": 40,
        "alpha": 0.05
      },
      "robustnessAgreeShare": 0.8,
      "holdoutAlpha": 0.05
    }
  },
  "q11": {
    "horizon": 7,
    "lagGrid": [0, 1, 2, 3, 4, 5, 7],
    "minTrainingLength": 60,
    "minValidOrigins": 60,
    "models": {
      "M0": "baseline",
      "M1": "intents",
      "M2": "price",
      "M3": "combined"
    },
    "fixtureDays": 400,
    "shortFixtureDays": 150,
    "randomCrossValidation": false
  },
  "q12": {
    "horizons": [1, 7, 14],
    "families": [
      "successful_actions",
      "unique_signer_proxies",
      "contract_diversity",
      "application_tagged_actions"
    ],
    "organicTags": ["organic"],
    "excludedFromOrganic": ["intents_verifier", "bridge"],
    "unclassifiedRule": "unclassified_is_not_organic",
    "tolerance": 1e-9,
    "baselinePair": {
      "baseline": "naive_last",
      "candidate": "seasonal_naive"
    },
    "combinedResultLabel": "non_primary"
  },
  "q13": {
    "detector": "row_identity_intersection",
    "reasonCode": "mechanical_overlap",
    "minSharedRowsToBlock": 1,
    "blockedStatus": "NOT_REPRODUCIBLE"
  },
  "q14": {
    "metricTolerance": 1e-9,
    "smapeZeroRule": "term_with_zero_denominator_is_zero",
    "minOriginsForPValue": 20,
    "dm": {
      "kernel": "bartlett",
      "maxLags": 5,
      "smallSample": "none",
      "reference": "student_t_n_minus_1",
      "sided": "two",
      "tolerance": 1e-9
    },
    "ar1Differential": {
      "n": 200,
      "phi": 0.6,
      "mean": 0.05,
      "sigma": 1.0,
      "seed": 730001
    },
    "fiveOriginCase": {
      "n": 5,
      "seed": 730002
    },
    "nullSimulation": {
      "n": 300,
      "phi": 0.5,
      "mean": 0.0,
      "sigma": 1.0,
      "alpha": 0.05,
      "band": [1, 10],
      "seeds": [
        710001, 710002, 710003, 710004, 710005, 710006, 710007, 710008, 710009, 710010, 710011, 710012,
        710013, 710014, 710015, 710016, 710017, 710018, 710019, 710020, 710021, 710022, 710023, 710024,
        710025, 710026, 710027, 710028, 710029, 710030, 710031, 710032, 710033, 710034, 710035, 710036,
        710037, 710038, 710039, 710040, 710041, 710042, 710043, 710044, 710045, 710046, 710047, 710048,
        710049, 710050, 710051, 710052, 710053, 710054, 710055, 710056, 710057, 710058, 710059, 710060,
        710061, 710062, 710063, 710064, 710065, 710066, 710067, 710068, 710069, 710070, 710071, 710072,
        710073, 710074, 710075, 710076, 710077, 710078, 710079, 710080, 710081, 710082, 710083, 710084,
        710085, 710086, 710087, 710088, 710089, 710090, 710091, 710092, 710093, 710094, 710095, 710096,
        710097, 710098, 710099, 710100
      ]
    },
    "interval": {
      "method": "moving_block_bootstrap_percentile",
      "level": 0.95,
      "block": 10,
      "nBoot": 300,
      "bootstrapSeed": 740001
    },
    "coverage": {
      "n": 200,
      "phi": 0.5,
      "trueMean": 0.2,
      "sigma": 1.0,
      "replicates": 200,
      "band": [0.88, 0.99],
      "seeds": [
        720001, 720002, 720003, 720004, 720005, 720006, 720007, 720008, 720009, 720010, 720011, 720012,
        720013, 720014, 720015, 720016, 720017, 720018, 720019, 720020, 720021, 720022, 720023, 720024,
        720025, 720026, 720027, 720028, 720029, 720030, 720031, 720032, 720033, 720034, 720035, 720036,
        720037, 720038, 720039, 720040, 720041, 720042, 720043, 720044, 720045, 720046, 720047, 720048,
        720049, 720050, 720051, 720052, 720053, 720054, 720055, 720056, 720057, 720058, 720059, 720060,
        720061, 720062, 720063, 720064, 720065, 720066, 720067, 720068, 720069, 720070, 720071, 720072,
        720073, 720074, 720075, 720076, 720077, 720078, 720079, 720080, 720081, 720082, 720083, 720084,
        720085, 720086, 720087, 720088, 720089, 720090, 720091, 720092, 720093, 720094, 720095, 720096,
        720097, 720098, 720099, 720100, 720101, 720102, 720103, 720104, 720105, 720106, 720107, 720108,
        720109, 720110, 720111, 720112, 720113, 720114, 720115, 720116, 720117, 720118, 720119, 720120,
        720121, 720122, 720123, 720124, 720125, 720126, 720127, 720128, 720129, 720130, 720131, 720132,
        720133, 720134, 720135, 720136, 720137, 720138, 720139, 720140, 720141, 720142, 720143, 720144,
        720145, 720146, 720147, 720148, 720149, 720150, 720151, 720152, 720153, 720154, 720155, 720156,
        720157, 720158, 720159, 720160, 720161, 720162, 720163, 720164, 720165, 720166, 720167, 720168,
        720169, 720170, 720171, 720172, 720173, 720174, 720175, 720176, 720177, 720178, 720179, 720180,
        720181, 720182, 720183, 720184, 720185, 720186, 720187, 720188, 720189, 720190, 720191, 720192,
        720193, 720194, 720195, 720196, 720197, 720198, 720199, 720200
      ]
    }
  },
  "q15": {
    "modelSelectionRule": "primary candidate and horizon fixed in the family; no selection among candidates, lags or windows after seeing results",
    "spike": {
      "removeTopDays": 1,
      "rule": "if removing the largest-gain day moves relative improvement below minRelativeImprovement the result cannot be SUPPORTED and strength is exploratory"
    },
    "verdictTable": [
      {
        "id": 1,
        "when": {
          "preregOk": false
        },
        "status": "NOT_REPRODUCIBLE",
        "strength": "exploratory"
      },
      {
        "id": 2,
        "when": {
          "preregOk": true,
          "complete": false
        },
        "status": "INSUFFICIENT_DATA",
        "strength": "exploratory"
      },
      {
        "id": 3,
        "when": {
          "complete": true,
          "enoughDevOrigins": false
        },
        "status": "INSUFFICIENT_DATA",
        "strength": "exploratory"
      },
      {
        "id": 4,
        "when": {
          "enoughDevOrigins": true,
          "devPass": false
        },
        "status": "UNSUPPORTED",
        "strength": "pre_registered"
      },
      {
        "id": 5,
        "when": {
          "devPass": true,
          "holdout": "none"
        },
        "status": "INSUFFICIENT_DATA",
        "strength": "pre_registered"
      },
      {
        "id": 6,
        "when": {
          "devPass": true,
          "holdout": "insufficient"
        },
        "status": "INSUFFICIENT_DATA",
        "strength": "pre_registered"
      },
      {
        "id": 7,
        "when": {
          "devPass": true,
          "holdout": "fail",
          "robustnessShare": 1.0,
          "placebo": "pass"
        },
        "status": "MIXED",
        "strength": "pre_registered"
      },
      {
        "id": 8,
        "when": {
          "devPass": true,
          "holdout": "pass",
          "robustnessShare": 0.5,
          "placebo": "pass"
        },
        "status": "MIXED",
        "strength": "pre_registered"
      },
      {
        "id": 9,
        "when": {
          "devPass": true,
          "holdout": "pass",
          "robustnessShare": 1.0,
          "placebo": "fail"
        },
        "status": "MIXED",
        "strength": "pre_registered"
      },
      {
        "id": 10,
        "when": {
          "devPass": true,
          "holdout": "pass",
          "robustnessShare": 1.0,
          "placebo": "pass"
        },
        "status": "SUPPORTED",
        "strength": "out_of_sample"
      },
      {
        "id": 11,
        "when": {
          "devPass": true,
          "holdout": "pass",
          "robustnessShare": 1.0,
          "placebo": "pass",
          "independentReplication": true
        },
        "status": "SUPPORTED",
        "strength": "independent_replication"
      },
      {
        "id": 12,
        "when": {
          "devPass": true,
          "holdout": "pass",
          "robustnessShare": 1.0,
          "placebo": "pass",
          "adversarialDisagreement": true
        },
        "status": "MIXED",
        "strength": "pre_registered"
      }
    ]
  },
  "q17": {
    "minHoldoutOrigins": 14,
    "lockboxRule": "opens once, only under a frozen preregistration hash; second independent evaluation refused; audit replay needs identical configuration hash, seeds and data digest",
    "replayTolerance": 1e-9,
    "fixtureDays": 400
  },
  "q18": {
    "variants": [
      "window_30d",
      "window_90d",
      "window_180d",
      "top_1pct_accounts_removed",
      "top_5pct_accounts_removed",
      "outlier_days_excluded",
      "stablecoin_only_routes",
      "non_stablecoin_routes",
      "pre_oct27_regime",
      "post_oct27_regime",
      "public_vs_confidential",
      "segment_targets"
    ],
    "windows": [30, 90, 180],
    "windowMinExtraDays": 26,
    "topCohortPct": [1, 5],
    "outlierQuantile": 0.95,
    "minPostRegimeRows": 60,
    "segmentHeadAccounts": 10,
    "fixtureDays": 190,
    "fixtureStart": "2026-05-06",
    "signFlipRule": "a computed variant whose delta_mae sign is opposite to the primary caps the headline status at MIXED; NOT_COMPUTABLE variants never count as agreement or flip"
  },
  "q19": {
    "maxArguments": 3,
    "numberRelativeTolerance": 1e-6,
    "checklist": [
      "every_argument_has_result_id",
      "every_number_matches_result",
      "at_most_three_arguments_per_side",
      "no_preregistration_edit",
      "both_branches_present"
    ]
  },
  "q20": {
    "tolerance": 1e-9,
    "manifestFields": [
      "experimentId",
      "preregistrationHash",
      "rawSnapshotHash",
      "metricVersionMap",
      "split",
      "models",
      "primaryLoss",
      "checks",
      "limitations",
      "artifactHashes"
    ],
    "placeholderPatterns": ["sha256:...", "YYYY-MM-DD"]
  },
  "q21": {
    "image": "node:24-bookworm-slim",
    "user": "65534:65534",
    "memoryMb": 128,
    "cpus": 1,
    "pidsLimit": 64,
    "timeBudgetSeconds": 6,
    "allocateMb": 512,
    "canaryEnv": "NEARESIS_CANARY_SECRET",
    "network": "none",
    "readOnlyRootfs": true
  },
  "q22": {
    "sections": [
      "Executive claim",
      "What would change our mind",
      "Sample and sources",
      "Methods",
      "Primary benchmark",
      "Evidence for",
      "Evidence against",
      "Confounders and blind spots",
      "Long-term economic mechanisms",
      "Verdict per claim",
      "Reproduction",
      "Unable to compute",
      "Source index",
      "Changes since previous version"
    ],
    "claimFields": [
      "verdict",
      "estimate",
      "uncertainty",
      "counterexample",
      "falsificationCondition",
      "provenance"
    ],
    "causalTerms": ["causes", "drives", "leads to", "caused by", "driven by"],
    "causalAllowlist": [
      "not cause",
      "does not cause",
      "no causal claim",
      "not a causal claim",
      "causality is excluded",
      "not causal"
    ],
    "bullishTerms": ["bullish", "will rally", "moon", "guaranteed"]
  }
}
```

<!-- frozen-parameters:end -->

An audit replay of an opened holdout with the identical frozen configuration (same configuration hash, seeds and data digest) is allowed, is stored as `audit_replay`, never counts as a new independent evaluation and never raises evidence strength. Any change to a frozen value after results exist makes the affected result `post-hoc registration`.

## Fields to freeze (live study, still to be filled in before any chain registration)

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
