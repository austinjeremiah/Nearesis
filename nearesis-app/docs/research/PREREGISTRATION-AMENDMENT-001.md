# Preregistration amendment 001: Q14 Diebold-Mariano variance estimation (post-hoc methodological correction)

Status: post_hoc_methodological_correction. This amendment does not replace, edit or re-freeze `PREREGISTRATION.md` or `PREREGISTRATION.freeze.json`. Those stay exactly as frozen (document hash sha256:965c2ef29bda21540c3eea38e118ca08d2d7eecbf9f7dd357251fd7949e65c2c, frozen 2026-11-11T06:43:50.646Z), and the original Q14 FAIL record stays in `reports/TESTS/Q14/` (run 2026-11-11T07-04-33-498Z-6ade5207, commit 6ade520).

Owner decision (2026-11-11, option 2): "Correct the Diebold-Mariano variance estimation and small-sample calibration. Preserve the original FAIL, document the methodological amendment, calibrate on separate data, then execute the revised test once against a newly frozen, unseen seed set. Do not widen the acceptance band or repeatedly rerun until PASS. Label the revised result post-hoc methodological correction, and rerun all dependent Q tests."

Amendment written at the UTC time recorded in `PREREGISTRATION-AMENDMENT-001.freeze.json` (field `frozenAt`), before any computation belonging to this amendment.

## 1. What happened and why this is post-hoc

1. Q14 criterion (c) was executed once under the original freeze. The frozen procedure (Bartlett HAC, 5 lags, Student t with n-1 degrees of freedom, two-sided alpha 0.05) rejected the true null in 12 of the 100 frozen seeds 710001 to 710100 (AR(1) phi 0.5, n 300, mean 0). The frozen band is 1 to 10. Verdict FAIL (FND-20261111-008). The i.i.d.-variance negative control rejected 30 of 100.
2. After the FAIL, an exploratory run over 2,000 non-frozen seeds found that the same procedure rejects about 8.45 percent of true nulls, so its true size exceeds 5 percent. That exploratory run motivated this amendment. It is disclosed as post-hoc and is not used for any verdict, for calibration, or for selection.
3. The correction below is therefore a methodological change made after seeing a failure. Its results carry the label `post_hoc_methodological_correction` and never `pre_registered` strength on the strength of this amendment alone.

## 2. What is fixed by this amendment and what is not

Unchanged, never to be altered by this amendment: the Q14 acceptance band 1 to 10 of 100 null rejections; alpha 0.05 two-sided; the null DGP (AR(1), phi 0.5, n 300, mean 0, sigma 1) and its n; every other Q14 criterion (a), (b) tolerance 1e-9, (d), (e) including the coverage band 0.88 to 0.99, (f); the original seeds 710001 to 710100, 730001, 730002, 740001 and the coverage seeds; the 2,000 exploratory seeds. The original seeds are never reused as the new null seeds.

Changed: only the long-run variance estimator and small-sample correction of the paired Diebold-Mariano statistic, chosen by the pre-declared rule in section 5.

## 3. Candidate estimators (fixed list, closed)

Notation: d is the loss differential of length n, centred c_t = d_t minus mean(d); gamma_k = (1/n) sum over t>k of c_t c_(t-k); BartlettLRV_L(x) = gamma_0 + 2 sum over k=1..L of (1 - k/(L+1)) gamma_k. Statistic t = mean(d) / sqrt(V/n), multiplied by the HLN factor where stated, compared with Student t with n-1 degrees of freedom, two-sided.

Shared definitions:

- NW94 lag rule: L = floor(4 (n/100)^(2/9)).
- Andrews AR(1) plug-in lag: rho = sum_{t>=2} c_t c_(t-1) / sum_{t>=2} c_(t-1)^2 clipped to [-0.97, 0.97]; alpha1 = 4 rho^2 / ((1-rho)^2 (1+rho)^2); S = 1.1447 (alpha1 n)^(1/3); L = min(floor(S), n-2).
- HLN (Harvey, Leybourne and Newbold 1997) factor for one-step horizon h=1: sqrt((n + 1 - 2h + h(h-1)/n)/n) = sqrt((n-1)/n).
- AR(1) prewhitening: rho as above, u_t = c_t - rho c_(t-1) for t>=2, V_u = BartlettLRV_L on u with divisor (n-1) and no re-centring, recoloured V = V_u / (1-rho)^2.

| id | variance V | lag L | small-sample factor |
|----|-----------|-------|---------------------|
| E0 | BartlettLRV_L on d (original frozen procedure, reported only as the baseline; not eligible) | 5 | none |
| E1 | BartlettLRV_L | NW94 rule | none |
| E2 | BartlettLRV_L | NW94 rule | HLN |
| E3 | BartlettLRV_L | Andrews AR(1) plug-in | none |
| E4 | BartlettLRV_L | Andrews AR(1) plug-in | HLN |
| E5 | prewhitened AR(1), recoloured | NW94 rule on u | none |
| E6 | prewhitened AR(1), recoloured | NW94 rule on u | HLN |
| E7 | prewhitened AR(1), recoloured | 0 (parametric AR(1)) | none |
| E8 | prewhitened AR(1), recoloured | 0 (parametric AR(1)) | HLN |

No other candidate, combination or parameter value may be added after calibration data is generated.

## 4. Calibration design (separate data)

- Null: AR(1) loss differential with mean 0, sigma 1, burn-in 100, generated exactly as the production null generator (numpy default_rng(seed), normal innovations).
- Grid: phi in {0, 0.3, 0.5, 0.7} crossed with n in {60, 150, 300}: 12 cells.
- 5,000 seeds per cell. Seed for cell index c (phi-major order, c = 3 x phiIndex + nIndex) and replicate r in 0..4999 is 5000000 + 10000 c + r. This range is disjoint from every seed used or viewed before (710001 to 710100, 730001, 730002, 740001, the coverage seeds, and the exploratory seeds, none of which exceed 999999 to the author's knowledge; the calibration module asserts disjointness from every seed in the frozen files).
- For each candidate and cell, empirical size = rejections at alpha 0.05 divided by 5,000. Every eligible candidate is evaluated on identical series.
- Calibration seeds are never used for evaluation; evaluation seeds (section 6) are never used for calibration.

## 5. Pre-declared selection rule (applied mechanically, no discretion)

1. A candidate (E1 to E8) qualifies only if its empirical size is within 0.040 to 0.060 in the primary cell (phi 0.5, n 300, the cell Q14 criterion (c) runs in) and within 0.025 to 0.075 in each of the other 11 cells.
2. Among qualifying candidates choose the one with the smallest maximum absolute deviation of size from 0.05 across all 12 cells.
3. Tie-break if two maxima differ by less than 0.0005: fewer correction components (count of: HLN factor, prewhitening, data-dependent lag), then lower id.
4. If no candidate qualifies, stop. Q14 remains FAIL, no new seeds are drawn, nothing is re-tuned, and this is reported.

## 6. Evaluation seed derivation and the single execution

- After calibration, a calibration result file is committed (full size table, selection outcome, its own hash).
- The 100 evaluation seeds are derived deterministically: seed_i = 10000000 + (uint32 of the first 4 bytes of SHA-256 of the ASCII string `<amendment document hash>|<calibration result hash>|<i>`) mod 2,000,000,000, for i = 0..99, redrawing with a counter suffix `|<i>|<k>` on any collision with an earlier seed, a calibration seed or an original seed. They are computed and frozen in one commit (the evaluation freeze record, with its own hash and freeze timestamp) before any DM statistic is computed on them.
- Q14 is then executed exactly once with `pnpm accept --id Q14 --session R3`. The one-shot log is keyed by the evaluation freeze hash. An audit replay is permitted only if the runner refuses to record purely because the tree became dirty; it uses the identical commit and seeds and is recorded as `audit_replay` with a result-hash comparison. A FAIL is final: no change, no new seeds, no further attempt.
- Q14 (b) uses the selected estimator in production and an independently written reference; the i.i.d. variance negative control must still be detected.

## 7. Dependent tests

Every Q test that uses the Diebold-Mariano procedure or depends on Q14 in `tests/TEST_INDEX.json`, plus Q01 to Q10, is rerun once each after the Q14 execution. Failures are reported, not tuned. Q19 is being re-recorded elsewhere and is left alone.

## Frozen parameters of this amendment

<!-- frozen-parameters:begin -->
```json
{
  "amendment": {
    "id": "AMENDMENT-001",
    "label": "post_hoc_methodological_correction",
    "supersedesNothing": true,
    "originalFreezeHash": "sha256:965c2ef29bda21540c3eea38e118ca08d2d7eecbf9f7dd357251fd7949e65c2c",
    "originalFailRun": "2026-11-11T07-04-33-498Z-6ade5207",
    "originalFailRejections": 12,
    "bandUnchanged": [1, 10],
    "alpha": 0.05,
    "sided": "two",
    "reference": "student_t_n_minus_1",
    "horizonForHLN": 1
  },
  "candidates": [
    {"id": "E0", "eligible": false, "variance": "bartlett", "lag": {"rule": "fixed", "value": 5}, "hln": false, "prewhiten": false},
    {"id": "E1", "eligible": true, "variance": "bartlett", "lag": {"rule": "nw94"}, "hln": false, "prewhiten": false},
    {"id": "E2", "eligible": true, "variance": "bartlett", "lag": {"rule": "nw94"}, "hln": true, "prewhiten": false},
    {"id": "E3", "eligible": true, "variance": "bartlett", "lag": {"rule": "andrews_ar1"}, "hln": false, "prewhiten": false},
    {"id": "E4", "eligible": true, "variance": "bartlett", "lag": {"rule": "andrews_ar1"}, "hln": true, "prewhiten": false},
    {"id": "E5", "eligible": true, "variance": "bartlett", "lag": {"rule": "nw94"}, "hln": false, "prewhiten": true},
    {"id": "E6", "eligible": true, "variance": "bartlett", "lag": {"rule": "nw94"}, "hln": true, "prewhiten": true},
    {"id": "E7", "eligible": true, "variance": "bartlett", "lag": {"rule": "fixed", "value": 0}, "hln": false, "prewhiten": true},
    {"id": "E8", "eligible": true, "variance": "bartlett", "lag": {"rule": "fixed", "value": 0}, "hln": true, "prewhiten": true}
  ],
  "rhoClip": 0.97,
  "andrewsConstant": 1.1447,
  "calibration": {
    "dgp": {"mean": 0.0, "sigma": 1.0, "burnIn": 100, "alpha": 0.05},
    "phi": [0, 0.3, 0.5, 0.7],
    "n": [60, 150, 300],
    "seedsPerCell": 5000,
    "seedBase": 5000000,
    "seedCellStride": 10000,
    "cellOrder": "phi_major",
    "primaryCell": {"phi": 0.5, "n": 300}
  },
  "selectionRule": {
    "primaryCellSizeBand": [0.04, 0.06],
    "otherCellSizeBand": [0.025, 0.075],
    "objective": "min_max_abs_size_deviation_from_alpha_over_all_cells",
    "tieMargin": 0.0005,
    "tieBreak": ["fewer_corrections", "lower_id"],
    "noQualifierOutcome": "stop_Q14_remains_FAIL"
  },
  "evaluationSeeds": {
    "count": 100,
    "base": 10000000,
    "modulus": 2000000000,
    "derivation": "sha256(<amendment document hash>|<calibration result hash>|<i>[|<k> on collision]) first 4 bytes uint32, mod modulus, plus base",
    "disjointFrom": ["originalFrozenSeeds", "calibrationSeeds"]
  }
}
```
<!-- frozen-parameters:end -->
