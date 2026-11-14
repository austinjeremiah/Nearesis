# Preregistration amendment 002: Q14 forecast comparison by fixed-smoothing inference (post-hoc methodological correction)

Status: post_hoc_methodological_correction. Authorised by the owner's binding specification `coordination/PROMPTS/R4_Q14_AMENDMENT_002_OWNER.md` (2026-11-11). This amendment does not replace, edit or re-freeze `PREREGISTRATION.md`, `PREREGISTRATION.freeze.json` or any of the Amendment 001 files. Amendment 001 remains unchanged and its outcome ("no candidate qualifies", `stop_Q14_remains_FAIL`) stays on record. The original Q14 FAIL (run 2026-11-11T07-04-33-498Z-6ade5207, commit 6ade520, 12 of 100 rejections against the band 1 to 10) stays on record.

The goal is valid inference for short, serially correlated comparisons, not a Q14 PASS. The thresholds, the 1 to 10 band and the 12 calibration scenarios do not change. Method roles are fixed here, before any calibration of this amendment is computed. If the primary method does not qualify, the certification path stops and Q14 remains FAIL.

## 1. Why Amendment 001 failed (verified from the source artifacts)

Recomputed directly from `PREREGISTRATION-AMENDMENT-001.calibration.json` and by re-running the calibration seeds: the original frozen procedure E0 (Bartlett HAC, 5 lags, Student t with n-1 df) rejects a true null 9.54 percent of the time at (phi 0.5, n 300) and 19.46 percent at (phi 0.7, n 60). The best Amendment 001 candidate E8 (AR(1) prewhitening, parametric AR(1) variance, HLN factor) gives 6.04 and 10.74 percent. None of E1 to E8 met the rule (4 to 6 percent primary, 2.5 to 7.5 percent elsewhere). All were heuristic combinations of a consistent-variance estimator with a Student-t reference. They keep the bandwidth negligible relative to n, which is the asymptotics Kiefer and Vogelsang (2005) show is inaccurate in small samples. This amendment replaces that family with a published fixed-smoothing procedure.

## 2. Literature to method mapping

| Source | What it supplies | Used here as |
|---|---|---|
| Diebold and Mariano (1995) | Statistic mean(d)/sqrt(LRV/n) on a loss differential d, null of equal expected loss | The hypothesis and statistic form |
| Harvey, Leybourne and Newbold (1997) | Small-sample factor sqrt((n+1-2h+h(h-1)/n)/n) and Student t reference for the rectangular-kernel DM variance (ForeComp `dm.test.r.m`). For h = 1 that variance is the i.i.d. variance | Reported baseline only, not eligible. Its h = 1 form ignores autocorrelation of d |
| Harvey, Leybourne and Whitehouse (2017) | Rectangular/HAC long-run variance estimates can be negative in small samples | Motivation: the primary estimator is a weighted periodogram, non-negative by construction. A non-positive variance returns a structured degenerate state, never a p-value |
| Kiefer and Vogelsang (2005) | Fixed-b asymptotics: with b = M/T fixed, the Bartlett HAC t statistic has a non-standard limit; quantile polynomial q(b) | Secondary sensitivity method S |
| Coroneo and Iacone (2020) | Fixed-b and fixed-m asymptotics for DM. Equations (7) to (9): weighted periodogram estimate, Daniell kernel, statistic converges to t with 2m df. Bandwidths found best in their Monte Carlo: M = floor(T^(1/2)) (Bartlett), m = floor(T^(1/3)) (WPE-D). Bootstrap comparators use the overlapping stationary block bootstrap | Primary method P (WPE-D, m = floor(T^(1/3)), t_2m). Secondary S bandwidth. Bootstrap robustness B |
| Coroneo, Iacone and Profumo (2024) | Extension of the fixed-smoothing comparison to survey density forecasts | Context only. Not used: Nearesis compares point forecasts |
| Clark and West (2007) | Adjusted MSPE statistic for nested models, because ordinary DM is not approximately normal under the null of nested models | Nested-model policy (section 6). Exploratory statistic only, not calibrated here |
| ForeComp 1.0.0 (CRAN, GPL >= 3) | `dm.test.wpe.fb`, `dm.test.bt.fb`, `dm.test.r.m` documented definitions | Independent oracle definitions (section 9). No ForeComp code is copied into Nearesis |

The Coroneo and Iacone statements above were read in the published paper (supporting equations (7) to (9), the bandwidth paragraph and Section 4.1 quantile formula). The quantile coefficients are those printed in that paper and used by `dm.test.bt.fb`. They are additionally verified by an independent simulation of the Kiefer and Vogelsang limit distribution (section 9). No critical value is taken from memory.

## 3. Audit of the hypothesis and of the original failure (done before this amendment)

1. Loss differential and sign: d_t = |e_base,t| - |e_candidate,t| for absolute-error loss (`inference.diebold_mariano`, `paired_comparison`). Positive d means the candidate has lower loss. Units are those of the loss (log1p scale for the primary loss). This amendment preserves sign and units.
2. Q14 null: the Q14 test does not fit models. It simulates the loss differential directly as AR(1) with mean exactly 0 (numpy default_rng, normal innovations, burn-in 100). The null of zero expected loss differential holds exactly and the process is stationary for |phi| < 1, so the generator is correct. The failure is the test's size, not the generator. The generator, the null and the seeds are not changed.
3. Alternative: two-sided (Q14 and `dm_paired`). `inference.diebold_mariano` used by the experiment pipeline is one-sided. This amendment makes the primary comparison two-sided, and any one-sided use must be pre-stated with its own claim.
4. Alignment: rolling-origin training uses rows whose target date is at or before the origin, and the scaler is fit on the training window only (verified by the Q11 access recorder). The step is 1 origin, so for horizon h > 1 the h-step errors overlap (an MA(h-1) structure at best) and the loss differential is serially dependent even under correct models.
5. Horizons 1, 7, 14: only horizon 1 has been calibrated. Horizons 7 and 14 are governed by section 7.
6. Effective observations: the number of valid out-of-sample origins is reported. Overlap reduces the information content below the origin count.
7. Multiple comparisons: the experiment pipeline applies Benjamini-Hochberg over a frozen family. A per-comparison inference status is added here. A comparison whose status is not VALID enters the family with p = 1 as before.
8. Nested or not (classification rule fixed below):
   - baseline M0 is nested in intents M1, price M2 and combined M3. M1 and M2 are each nested in M3.
   - M1 versus M2 is non-nested.
   - naive_last is nested in every ridge model because the lag-0 target series is a feature. seasonal_naive and moving_avg_7 are not linear restrictions of the feature spans and are non-nested against the ridge models.
   - all Q14 acceptance inputs are synthetic loss differentials. They are not model comparisons, so Q14 itself is outside the nested policy.
9. Estimation window: expanding window, ridge refit at each origin. The Clark and West sampling theory covers this setting only for squared-error loss.

## 4. Statistical hypotheses, loss and sign

- Null: E[d_t] = 0 for the stationary loss differential d_t = L(e_base,t) - L(e_candidate,t). Alternative: E[d_t] differs from 0 (two-sided). Alpha 0.05.
- Primary loss: absolute error (MAE) on the log1p scale, as in the preregistration. Squared error is permitted only through the Clark and West path.
- Sign: positive d favours the candidate. Test statistic sign equals mean(d) sign.

## 5. Methods (roles fixed before calibration)

Notation: d of length n, dbar its mean. Fourier frequencies lambda_j = 2 pi j / n. I(lambda_j) = |(2 pi n)^(-1/2) sum_t d_t exp(-i lambda_j t)|^2.

- **P, primary (certification path).** Coroneo and Iacone WPE with Daniell kernel. m = floor(n^(1/3)). Omega_hat = (2 pi / m) sum_{j=1..m} I(lambda_j). Statistic t = sqrt(n) dbar / sqrt(Omega_hat), referred to Student t with 2m degrees of freedom, two-sided. The periodogram at non-zero Fourier frequencies is invariant to the mean, so no demeaning is applied. p = 2 P(t_2m > |t|). If Omega_hat is not strictly positive (constant d) the state is DEGENERATE_VARIANCE and no statistic or p-value is returned.
- **S, secondary (sensitivity only).** Kiefer and Vogelsang fixed-b Bartlett. M = floor(n^(1/2)) (the Coroneo and Iacone baseline), b = M/n. LRV = [gamma_0 + 2 sum_{k=1..M-1} (1 - k/M) gamma_k] with gamma_k the biased sample autocovariances of d (centred). Statistic t = dbar / sqrt(LRV/n). Critical value q(b) = 1.9600 + 2.9694 b + 0.4160 b^2 - 0.5324 b^3 (0.975 quantile, alpha 0.05 two-sided, from the Coroneo and Iacone paper formulation of the Kiefer and Vogelsang results). Only a reject or not-reject decision is returned because no p-value formula is supported. S is an approximation of the fixed-b limit by a cubic polynomial.
- **B, optional robustness (sensitivity only).** Studentised, null-centred stationary block bootstrap (Politis and Romano 1994, overlapping circular blocks as used in the Coroneo and Iacone comparison). Statistic t = dbar / sqrt(LRV_Bartlett(M0)/n) with M0 = floor(n^(1/3)). Mean block length floor(n^(1/3)), at least 2 (frozen deterministic rule, not tuned). 499 replications. Bootstrap samples are drawn from the original d (pairing of losses preserved by resampling d_t as a unit). For each bootstrap sample d*, t* = (mean(d*) - dbar)/sqrt(LRV*/n) with LRV* computed on d* with the same M0, which imposes the null. p = (1 + #{|t*| >= |t|}) / (1 + 499). RNG: numpy PCG64 `default_rng(SeedSequence([seed, 2]))`, where seed is the series seed. A single block length rule is used. No other block length is tried.
- **Reported baselines (not eligible, never selected):** E0 (original frozen estimator), E8 (best of Amendment 001), and HLN-r.m (`dm.test.r.m` at h = 1).

**Role rules.**
1. P is the only method that can certify Q14 and the only method whose result can carry the label "calibrated" for a significance claim.
2. There is no substitution rule. S and B can never become primary under this amendment, whatever the calibration shows.
3. S and B are reported beside P in every comparison artifact. Disagreement is preserved verbatim (`agreement: agree | disagree | not_available`). A disagreement cannot create a stronger conclusion, and a method choice cannot be made by minimum p-value.
4. S or B, if their own calibration fails the same bands, are labelled `METHOD_NOT_VALIDATED` in artifacts and carry no weight.

## 6. Eligibility and nested-model policy

Inference status values: `VALID`, `INSUFFICIENT_DATA`, `METHOD_NOT_VALIDATED`, `DEGENERATE_VARIANCE`, `INVALID_INPUT`.

1. Non-finite or mismatched inputs: `INVALID_INPUT`.
2. n < 20 valid origins (the frozen `minOriginsForPValue`): `INSUFFICIENT_DATA`, no statistic.
3. 20 <= n < 60: a statistic and p-value are computed for transparency, status `METHOD_NOT_VALIDATED` (the smallest calibrated cell is n = 60), and no significance claim is allowed. Informational probe cells (section 8) may document the size there but cannot lower the minimum.
4. Constant loss differential or non-positive variance: `DEGENERATE_VARIANCE`.
5. Nested models (by the classification in section 3, applied from the declared model names, unknown pairs treated as nested): ordinary DM inference is not used. Status `METHOD_NOT_VALIDATED`. The observed mean loss difference is reported, together with the Clark and West adjusted-MSPE statistic f_t = e_base,t^2 - (e_cand,t^2 - (yhat_base,t - yhat_cand,t)^2) with the WPE variance of section 5 and one-sided alternative, as `exploratory_only`. That CW statistic is not calibrated by this amendment and supports no significance claim. The primary loss is absolute error, for which no nested theory is claimed.
6. Non-nested comparison, horizon 1, n >= 60: `VALID` if and only if the P calibration qualified (section 8). Otherwise `METHOD_NOT_VALIDATED` (the calibration failed).
7. Horizon h > 1: origins overlap. Eligible only for h in {7, 14} and n >= 150, and only for the (h, n) overlap-check cells (section 8) whose P size lies within 2.5 to 7.5 percent. All other cases are `METHOD_NOT_VALIDATED`.
8. Training-window alignment violations detected upstream make the result `INVALID_INPUT`.

## 7. Horizon handling

Horizon 1 is the Q14 calibration scenario. For h in {7, 14} the loss differential of overlapping h-step forecasts is modelled for the overlap check as d_t = sum_{k=0..h-1} e_{t-k} with e i.i.d. N(0,1), a stylised MA(h-1) null with mean 0. The result decides section 6 item 7 mechanically. Origins are never thinned post hoc to manufacture independence.

## 8. Calibration, applicability and power designs (all frozen)

- **Calibration null** (the 12 original scenarios, unchanged): AR(1) loss differential, mean 0, sigma 1, burn-in 100, phi in {0, 0.3, 0.5, 0.7} crossed with n in {60, 150, 300}. 5,000 independent series per cell. The same series are used for every method. Seed of cell c (phi-major, c = 3 phiIndex + nIndex), replicate r: 20,000,000 + 10,000 c + r. This namespace is disjoint from Amendment 001 (5,000,000 to 5,119,999), the original Q14 seeds, the exploratory seeds and the final evaluation seeds, and the module asserts it.
- **Qualification rule (unchanged thresholds).** P qualifies if its empirical size is within 0.040 to 0.060 at (phi 0.5, n 300) and within 0.025 to 0.075 in each of the other 11 cells. S and B are assessed by the same bands for their labels only. No tuning of alpha, m, M, block length or critical values after any result.
- **Recorded per method and cell:** rejection count and rate, 95 percent Wilson interval, size distortion, test-statistic distribution (mean, sd, 1/5/50/95/99 percentiles), critical value distribution (S: constant; P: constant t_2m quantile; B: bootstrap quantile of |t*| 0.95 summarised), LRV bias relative to the true long-run variance of the AR(1) (mean ratio estimate/true), invalid or degenerate counts, runtime, peak memory, parameters, and E0, E8 and HLN-r.m comparison on the same series.
- **Overlap check:** h in {7, 14} by n in {150, 300}, MA(h-1) null, 2,000 series per cell, seeds 30,000,000 + 10,000 c + r.
- **Applicability probes (informational only):** phi in {0, 0.5} by n in {20, 30, 40}, 2,000 series, seeds 40,000,000 + 10,000 c + r.
- **Power, family A (loss-differential shift):** d = mu + AR(1) noise (sigma 1, burn-in 100), phi in {0, 0.5, 0.7}, n in {60, 150, 300}, mu in {0.10 (weak), 0.20 (medium), 0.40 (strong)}, 2,000 series per cell, seeds 50,000,000 + 10,000 c + r in phi, n, mu order.
- **Power, family B (genuine forecaster difference, non-nested):** error of forecaster A is eta_t, an AR(1) with phi 0.5 and unit innovations. Error of forecaster B is eta_t - c u_t with u_t i.i.d. N(0,1) independent noise injected into B's forecast. d_t = |e_B,t| - |e_A,t|, so d > 0 means A is better. c in {0.30 (weak), 0.60 (medium), 1.00 (strong)}, n in {60, 150, 300}, 2,000 series per cell, seeds 60,000,000 + 10,000 c + r. The true mean loss improvement is estimated with 400,000 draws (seed 61,000,000). Power, mean estimated improvement and its 2.5 and 97.5 percentiles are reported with Wilson intervals.
- Power results are reported as measured. A procedure with power under 5 percent in the strong cells of the largest n is recorded as `power_inadequate` in the artifacts' limitations. Nothing is changed after inspecting the alternative data.

## 9. Independent oracles and numerical tolerances

- **WPE oracle.** The Coroneo and Iacone equations (8) and (9) as documented for `ForeComp::dm.test.wpe.fb` are re-implemented in `tests/python/research/reference_dm_fixed_smoothing.py` by a code path that shares nothing with production: pure Python (no numpy, no scipy), a naive explicit complex-exponential sum for the periodogram, and the Student t tail from the exact elementary closed form that exists for even degrees of freedom (2m is always even). Frozen reference vectors in `packages/test-fixtures/research/dm-fixed-smoothing-vectors.json` carry the oracle values.
- **ForeComp execution.** An attempt to obtain a project-local R runtime was refused by the environment's permission policy (download of an executable), so ForeComp itself is not executed. This limitation is recorded in the artifacts. The oracle is therefore an independent re-derivation from the published equations and the ForeComp documentation, plus hand-computable closed-form cases (a pure sinusoid at a Fourier frequency, a two-point pattern), not a second copy of the production implementation. Should ForeComp later become executable, a cross-check against the frozen vectors can be added without changing this amendment.
- **Fixed-b critical values.** Verified independently by Monte Carlo simulation of the Kiefer and Vogelsang limit (Brownian bridge functional) in the oracle module, with a stated tolerance of 0.06 absolute on q(b) at b in {0.1, 0.2, 0.5, 1}.
- **Tolerances.** P statistic and p-value against the oracle: absolute 1e-9 on the statistic and 1e-9 on the p-value. S statistic 1e-9, critical value 1e-12 against the polynomial. Bootstrap p-value exact equality under the frozen RNG against an independent plain-loop implementation of the same algorithm.

## 10. Evaluation seed commitment and the single execution

- If and only if P qualifies: 100 evaluation seeds are derived as seed_i = 1,000,000,000 + (uint32 of the first 4 bytes of SHA-256 of ASCII `<amendment document hash>|<calibration result hash>|<i>`) mod 1,000,000,000, redrawing with suffix `|<i>|<k>` on any collision with an earlier seed, any calibration, overlap, probe or power seed, or any original seed. They are written to the evaluation freeze record with its own hash and timestamp, committed before any statistic is computed on them.
- Q14 is then executed once with the band 1 to 10 unchanged and every other original criterion (a) to (f) unchanged. Q14 (b) uses P in production and the oracle. The i.i.d. variance negative control must still be detected. A FAIL is final: no new seeds, no change, no further attempt. An audit replay is allowed only if the runner refuses to record purely because the tree is dirty (identical commit and seeds, recorded as `audit_replay`, result hashes compared).
- If P does not qualify: no evaluation seeds are frozen, no final execution is made, Q14 remains FAIL, and methodological experimentation under this amendment stops. The application continues with significance claims marked exploratory or unsupported.

## 11. Stop conditions

1. P fails qualification: stop, Q14 FAIL, no evaluation freeze.
2. The oracle disagrees with production beyond tolerance: fix production, never the oracle or the tolerance, and record it.
3. No new method, bandwidth, block length, critical value or threshold may be added after calibration data exists.
4. The evaluation set is never used for calibration.

## 12. Expected outputs

`PREREGISTRATION-AMENDMENT-002.freeze.json`, `PREREGISTRATION-AMENDMENT-002.calibration.json`, `PREREGISTRATION-AMENDMENT-002.applicability.json` (overlap, probes, power), and if qualified `PREREGISTRATION-AMENDMENT-002.evaluation-freeze.json` and the Q14 evidence. Research artifacts carry method ID, version, amendment hash, nested flag, horizon, origins, loss, mean paired difference, interval where valid, statistic, p-value where valid, autocorrelation diagnostics, inference status, calibration reference, result IDs, data snapshot hash, preregistration status and limitations. The label of every result under this amendment is `post_hoc_methodological_correction`.

## Frozen parameters of this amendment

<!-- frozen-parameters:begin -->
```json
{
  "amendment": {
    "id": "AMENDMENT-002",
    "label": "post_hoc_methodological_correction",
    "methodVersion": "fixed-smoothing-dm/1.0.0",
    "supersedesNothing": true,
    "amendment001": {"unchanged": true, "outcome": "stop_Q14_remains_FAIL", "calibrationResultHash": "sha256:d6d65b9828fe8debe083e1b1d119743d235ff0042b57cbd2f9d4c2869022c606"},
    "originalFreezeHash": "sha256:965c2ef29bda21540c3eea38e118ca08d2d7eecbf9f7dd357251fd7949e65c2c",
    "originalFailRun": "2026-11-11T07-04-33-498Z-6ade5207",
    "originalFailRejections": 12,
    "bandUnchanged": [1, 10],
    "alpha": 0.05,
    "sided": "two"
  },
  "methods": {
    "P": {"role": "primary", "id": "wpe_fixed_m_daniell", "mRule": "floor_n_pow_1_3", "reference": "student_t_2m"},
    "S": {"role": "sensitivity_only", "id": "bartlett_fixed_b", "MRule": "floor_n_pow_1_2", "criticalValue": "kv2005_cubic_0.975", "coefficients": [1.96, 2.9694, 0.416, -0.5324]},
    "B": {"role": "sensitivity_only", "id": "stationary_bootstrap_studentised", "blockRule": "floor_n_pow_1_3_min_2", "lrvLagRule": "floor_n_pow_1_3", "reps": 499, "rng": "pcg64_seedsequence_seed_2"},
    "baselines": ["E0", "E8", "HLN_rm_h1"],
    "substitutionRule": "none"
  },
  "eligibility": {"minOrigins": 20, "minCalibratedN": 60, "multistepHorizons": [7, 14], "multistepMinN": 150, "nestedPolicy": "METHOD_NOT_VALIDATED_exploratory_clark_west"},
  "calibration": {
    "dgp": {"mean": 0.0, "sigma": 1.0, "burnIn": 100},
    "phi": [0, 0.3, 0.5, 0.7],
    "n": [60, 150, 300],
    "seedsPerCell": 5000,
    "seedBase": 20000000,
    "seedCellStride": 10000,
    "cellOrder": "phi_major",
    "primaryCell": {"phi": 0.5, "n": 300}
  },
  "selectionRule": {
    "primaryCellSizeBand": [0.04, 0.06],
    "otherCellSizeBand": [0.025, 0.075],
    "certifiedMethod": "P",
    "noQualifierOutcome": "stop_Q14_remains_FAIL"
  },
  "overlapCheck": {"horizons": [7, 14], "n": [150, 300], "seedsPerCell": 2000, "seedBase": 30000000, "seedCellStride": 10000, "band": [0.025, 0.075]},
  "applicabilityProbe": {"phi": [0, 0.5], "n": [20, 30, 40], "seedsPerCell": 2000, "seedBase": 40000000, "seedCellStride": 10000},
  "powerA": {"phi": [0, 0.5, 0.7], "n": [60, 150, 300], "mu": [0.1, 0.2, 0.4], "labels": ["weak", "medium", "strong"], "seedsPerCell": 2000, "seedBase": 50000000, "seedCellStride": 10000},
  "powerB": {"phiEtaA": 0.5, "c": [0.3, 0.6, 1.0], "labels": ["weak", "medium", "strong"], "n": [60, 150, 300], "seedsPerCell": 2000, "seedBase": 60000000, "seedCellStride": 10000, "truthDraws": 400000, "truthSeed": 61000000},
  "tolerances": {"statistic": 1e-9, "pValue": 1e-9, "criticalValue": 1e-12, "kvLimitSimulationAbs": 0.06},
  "evaluationSeeds": {
    "count": 100,
    "base": 1000000000,
    "modulus": 1000000000,
    "derivation": "sha256(<amendment document hash>|<calibration result hash>|<i>[|<k> on collision]) first 4 bytes uint32, mod modulus, plus base",
    "disjointFrom": ["originalFrozenSeeds", "amendment001CalibrationSeeds", "calibrationSeeds", "overlapSeeds", "probeSeeds", "powerSeeds"]
  }
}
```
<!-- frozen-parameters:end -->
