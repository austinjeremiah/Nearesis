import { scanSignificanceClaims, type GuardViolation } from "../research-inference-guard.ts";

/**
 * Language guards for the interpretation stage (final_master_prompt s10/s20). No statistical test is run by this stage,
 * so nothing it writes may claim significance or causation; the research-inference guard (Amendment 002) is applied with
 * `primaryStatisticalClaim: "not_supported"` and extended here with the causal and inference-language rules.
 */
export type InterpretationRule =
  | "significance_claim_without_valid_inference"
  | "lower_error_cites_p_value"
  | "state_upgraded"
  | "causal_claim"
  | "significance_claim"
  | "observation_uses_inference_language";

export interface InterpretationViolation {
  rule: InterpretationRule;
  detail: string;
}

const NEGATION = /\b(?:not|no|never|neither|nor|cannot|without|n't|nothing|rather than|does not|do not)\b/i;

/** Causal assertions. A hit is allowed only when a negation precedes it within the same clause ("does not imply causation"). */
const CAUSAL: RegExp[] = [
  /\b(?:cause[sd]?|causing)\b/gi,
  /\bcausal(?:ly)?\b|\bcausation\b/gi,
  /\b(?:drives?|drove|driven|driving)\b/gi,
  /\bdue to\b/gi,
  /\bbecause(?: of)?\b/gi,
  /\bas a result(?: of)?\b/gi,
  /\bresult(?:s|ed|ing)? (?:in|from)\b/gi,
  /\blead(?:s|ing)? to\b|\bled to\b/gi,
  /\bexplain(?:s|ed)?\b/gi,
  /\bresponsible for\b/gi,
  /\bthanks to\b/gi,
  /\btrigger(?:s|ed|ing)?\b/gi,
  /\bimpact(?:s|ed)? (?:of|on)\b/gi,
  /\bcontribut(?:e|es|ed|ing) to\b/gi,
  /\b(?:fuel|fuels|fueled|fuelled|fuelling|spur|spurs|spurred)\b/gi,
];

/** Significance / statistics vocabulary: no test was run, so none of it may be claimed. */
const SIGNIFICANCE: RegExp[] = [
  /\bsignifican(?:t|tly|ce)\b/gi,
  /\bstatistically\b/gi,
  /\bp[- ]?values?\b/gi,
  /\bp\s*(?:=|<|≤)\s*0?\.\d+/gi,
  /\bconfidence (?:interval|level)\b/gi,
  /\bcointegrat\w*|\bgranger\b/gi,
];

/** Language that goes beyond describing the rows: only an `inference` may use it. */
const INFERENCE_LANGUAGE =
  /\b(?:suggests?|suggesting|implies|implying|indicates? that|likely|probably|presumably|appears? to|seems? to|consistent with|correlat\w+|co-?mov\w+|relationship|tracks|mirrors?)\b/gi;

function hits(text: string, res: RegExp[], allowNegated: boolean): string[] {
  const out: string[] = [];
  for (const re of res) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const start = m.index ?? 0;
      const before = text.slice(Math.max(0, start - 48), start);
      // the clause the match sits in: after the last sentence/semicolon break
      const clause = before.split(/[.;:!?]/).pop() ?? "";
      if (allowNegated && NEGATION.test(clause)) continue;
      out.push(m[0]);
    }
  }
  return out;
}

export const causalClaims = (text: string): string[] => hits(text, CAUSAL, true);
export const significanceClaims = (text: string): string[] => hits(text, SIGNIFICANCE, true);
export const inferenceLanguage = (text: string): string[] => hits(text, [INFERENCE_LANGUAGE], false);

/** The research-inference guard applied to this stage: there is never a validated significance test here. */
const NO_VALID_TEST = { primaryStatisticalClaim: "not_supported" as const };

/**
 * Violations of one analyst statement. `basis` observation may not use inference language; no basis may assert causation
 * or significance (a negated mention such as "does not show causation" is allowed).
 */
export function scanFindingText(
  statement: string,
  limitations: readonly string[],
  basis: "observation" | "inference",
): InterpretationViolation[] {
  const text = [statement, ...limitations].join(" ");
  const out: InterpretationViolation[] = [];
  for (const v of scanSignificanceClaims(text, NO_VALID_TEST) as GuardViolation[])
    out.push({ rule: v.rule, detail: v.detail });
  const c = causalClaims(text);
  if (c.length)
    out.push({
      rule: "causal_claim",
      detail: `causal language without a validated test: ${[...new Set(c.map((x) => x.toLowerCase()))].join(", ")}`,
    });
  const s = significanceClaims(text);
  if (s.length)
    out.push({
      rule: "significance_claim",
      detail: `significance language but no test was run: ${[...new Set(s.map((x) => x.toLowerCase()))].join(", ")}`,
    });
  if (basis === "observation") {
    const i = inferenceLanguage(statement);
    if (i.length)
      out.push({
        rule: "observation_uses_inference_language",
        detail: `an observation may only describe the rows; inference wording: ${[...new Set(i.map((x) => x.toLowerCase()))].join(", ")}`,
      });
  }
  return out;
}

/** Skeptic notes may argue alternative causes ("could be due to"), but may not claim significance or a test. */
export function scanSkepticText(note: string): InterpretationViolation[] {
  const out: InterpretationViolation[] = [];
  for (const v of scanSignificanceClaims(note, NO_VALID_TEST)) out.push({ rule: v.rule, detail: v.detail });
  const s = significanceClaims(note);
  if (s.length)
    out.push({
      rule: "significance_claim",
      detail: `significance language in a skeptic note: ${s.join(", ")}`,
    });
  return out;
}

export const CORRELATION_NOT_CAUSATION =
  "Correlation is not causation: series that move together do not show that one drives the other, and no statistical test was run, so no significance is claimed.";
