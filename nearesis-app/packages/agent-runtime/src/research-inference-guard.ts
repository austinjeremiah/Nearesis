/**
 * Guards that keep an invalid or uncalibrated forecast comparison from becoming a significance claim
 * (Amendment 002, ADR-20261111-004). Pure functions over the research artifact's `estimates.inferenceSummary`
 * and per-comparison `inference` records; the reference implementation is `validate_thesis` in
 * `services/research/nearesis_research/thesis.py`.
 */

export type ComparisonState =
  | "evidence_supports_difference"
  | "insufficient_to_distinguish"
  | "comparison_method_not_validated"
  | "comparison_invalid_input";

export interface InferenceSummaryLike {
  primaryStatisticalClaim: "supported" | "not_supported";
  comparisons?: Record<
    string,
    { status: string; nested: boolean; significanceClaimAllowed: boolean; conclusion: ComparisonState }
  >;
}

export interface InferenceRecordLike {
  status: string;
  mean_diff?: number | null;
  significance_claim_allowed: boolean;
  conclusion: { state: ComparisonState; observed_candidate_lower_error: boolean | null };
  agreement?: string;
}

export interface GuardViolation {
  rule: "significance_claim_without_valid_inference" | "lower_error_cites_p_value" | "state_upgraded";
  detail: string;
}

const SIGNIFICANCE =
  /(?<!not )(?<!no )(?<!never )statistically significant|(?<!not )(?<!no )\bsignificant (gain|improvement|difference|effect|advantage)s?\b|\bsignificantly (better|improv\w+|different|outperform\w*)/i;
const LOWER_ERROR = /lower (observed )?(forecast )?error/i;
const P_VALUE = /\bp\s*(=|<|≤)\s*0?\.\d+/i;

/** Auditor: reject a draft that asserts significance while the cited comparison is not validly significant. */
export function scanSignificanceClaims(text: string, summary: InferenceSummaryLike): GuardViolation[] {
  const out: GuardViolation[] = [];
  if (summary.primaryStatisticalClaim !== "supported" && SIGNIFICANCE.test(text)) {
    out.push({
      rule: "significance_claim_without_valid_inference",
      detail:
        "draft asserts statistical significance but the comparison inference is not valid or not supported",
    });
  }
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (LOWER_ERROR.test(sentence) && P_VALUE.test(sentence)) {
      out.push({
        rule: "lower_error_cites_p_value",
        detail: "a lower-observed-error statement must cite the mean paired loss difference, not a p-value",
      });
    }
  }
  return out;
}

/** Skeptic: the objection to add when the primary statistical claim is not supported. */
export function skepticInferenceObjections(
  summary: InferenceSummaryLike,
  inferenceStatus?: string,
): string[] {
  const objs: string[] = [];
  if (summary.primaryStatisticalClaim === "not_supported") {
    objs.push(
      `statistical significance not established (inference status ${inferenceStatus ?? "not_supported"}); a lower observed forecast error is not evidence of a statistically meaningful difference`,
    );
  }
  const nested = Object.values(summary.comparisons ?? {}).filter((c) => c.nested).length;
  if (nested > 0) {
    objs.push(
      `${nested} comparison(s) are nested-model comparisons; ordinary Diebold-Mariano inference is not valid under the null`,
    );
  }
  return objs;
}

/** Composer: verbatim state and status, never upgraded; a primary/sensitivity disagreement is a limitation. */
export function composerInferenceLine(inf: InferenceRecordLike): { text: string; limitations: string[] } {
  const limitations: string[] = [];
  if (inf.agreement === "disagree") {
    limitations.push(
      "primary and sensitivity inference methods disagree; this weakens, never strengthens, the conclusion",
    );
  }
  return { text: `comparison state ${inf.conclusion.state}; inference status ${inf.status}`, limitations };
}

/** A draft may only state a state at least as strong as the record supports. */
export function checkStateNotUpgraded(claimed: ComparisonState, inf: InferenceRecordLike): GuardViolation[] {
  if (
    claimed === "evidence_supports_difference" &&
    !(inf.significance_claim_allowed && inf.status === "VALID")
  ) {
    return [
      {
        rule: "state_upgraded",
        detail: `claimed ${claimed} but the record is ${inf.conclusion.state} (${inf.status})`,
      },
    ];
  }
  if (
    (claimed === "insufficient_to_distinguish" || claimed === "comparison_method_not_validated") &&
    inf.conclusion.state !== claimed &&
    inf.conclusion.state === "comparison_invalid_input"
  ) {
    return [
      { rule: "state_upgraded", detail: `claimed ${claimed} but the record is ${inf.conclusion.state}` },
    ];
  }
  return [];
}
