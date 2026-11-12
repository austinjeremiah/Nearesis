import { expect, it } from "vitest";
import {
  checkStateNotUpgraded,
  composerInferenceLine,
  scanSignificanceClaims,
  skepticInferenceObjections,
  type InferenceRecordLike,
  type InferenceSummaryLike,
} from "../src/research-inference-guard.ts";

const notSupported: InferenceSummaryLike = {
  primaryStatisticalClaim: "not_supported",
  comparisons: {
    "1:intents": {
      status: "METHOD_NOT_VALIDATED",
      nested: true,
      significanceClaimAllowed: false,
      conclusion: "comparison_method_not_validated",
    },
  },
};
const supported: InferenceSummaryLike = { primaryStatisticalClaim: "supported" };

it("auditor rejects significance wording when the inference is not valid", () => {
  for (const t of [
    "The intents model is statistically significant against the baseline.",
    "This is a significant gain over the baseline.",
    "The candidate is significantly better than the baseline.",
  ]) {
    expect(
      scanSignificanceClaims(t, notSupported).map((v) => v.rule),
      t,
    ).toContain("significance_claim_without_valid_inference");
  }
});

it("negated or neutral wording is accepted", () => {
  for (const t of [
    "Statistical significance is not established for this comparison.",
    "The result is not statistically significant.",
    "The candidate had a lower observed error (mean paired difference 0.002).",
  ]) {
    expect(scanSignificanceClaims(t, notSupported), t).toEqual([]);
  }
});

it("significance wording is permitted only when the primary claim is supported", () => {
  expect(scanSignificanceClaims("The gain is statistically significant.", supported)).toEqual([]);
});

it("a lower-error statement must not cite a p-value", () => {
  const v = scanSignificanceClaims("The candidate shows lower observed error, p = 0.03.", notSupported);
  expect(v.map((x) => x.rule)).toContain("lower_error_cites_p_value");
});

it("skeptic adds the not-established objection and names nested comparisons", () => {
  const o = skepticInferenceObjections(notSupported, "METHOD_NOT_VALIDATED");
  expect(o[0]).toContain("statistical significance not established (inference status METHOD_NOT_VALIDATED)");
  expect(o.some((x) => x.includes("nested"))).toBe(true);
  expect(skepticInferenceObjections(supported)).toEqual([]);
});

const rec = (
  state: InferenceRecordLike["conclusion"]["state"],
  status: string,
  allowed = false,
): InferenceRecordLike => ({
  status,
  mean_diff: 0.002,
  significance_claim_allowed: allowed,
  conclusion: { state, observed_candidate_lower_error: true },
});

it("composer copies state and status verbatim and records disagreement as a limitation", () => {
  const r = composerInferenceLine({
    ...rec("comparison_method_not_validated", "METHOD_NOT_VALIDATED"),
    agreement: "disagree",
  });
  expect(r.text).toBe(
    "comparison state comparison_method_not_validated; inference status METHOD_NOT_VALIDATED",
  );
  expect(r.limitations).toHaveLength(1);
});

it("a state is never upgraded to a finding", () => {
  expect(
    checkStateNotUpgraded(
      "evidence_supports_difference",
      rec("comparison_method_not_validated", "METHOD_NOT_VALIDATED"),
    ),
  ).toHaveLength(1);
  expect(
    checkStateNotUpgraded("evidence_supports_difference", rec("evidence_supports_difference", "VALID", true)),
  ).toEqual([]);
  expect(
    checkStateNotUpgraded("insufficient_to_distinguish", rec("comparison_invalid_input", "INVALID_INPUT")),
  ).toHaveLength(1);
});
