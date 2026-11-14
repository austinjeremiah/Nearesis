/**
 * Test `relationship-v1`: a DESCRIPTIVE correlation rule over the two aligned daily series of a workspace-run capsule.
 * The thresholds are constants of the rule, fixed here before any run; they are not tuned to a result. It is not a
 * significance test and a correlation does not show cause. Correlations are exact integers in parts per million, as the
 * capsule's pinned verifier computes them.
 */
export const RULE_ID = "relationship-v1";
export const RULE = {
  id: RULE_ID,
  lagDays: 7,
  minDays: 30,
  supportedMinDays: 60,
  supportedSameDayPpm: 500_000,
  supportedLagPpm: 300_000,
  notSupportedBelowPpm: 200_000,
} as const;

export type VerdictStatus = "SUPPORTED" | "NOT_SUPPORTED" | "MIXED" | "INSUFFICIENT_DATA";

export type RuleCode =
  | "N_BELOW_MIN"
  | "COVERAGE_NOT_COMPLETE"
  | "CORRELATION_UNDEFINED"
  | "LAG_UNAVAILABLE"
  | "MET"
  | "SAME_DAY_BELOW_FLOOR"
  | "THRESHOLDS_NOT_ALL_MET";

export interface RuleInput {
  n: number;
  pearsonPpm: bigint | null;
  lagPpm: bigint | null;
  /** true: every day used has complete coverage in both panels; false: not; null: coverage is not stated. */
  coverageComplete: boolean | null;
}

/**
 * INSUFFICIENT_DATA if n < minDays, coverage is not complete for the used days (or not stated), or the correlation is
 * undefined; SUPPORTED if n >= supportedMinDays, same-day >= 0.5 and the 7-day-lag correlation has the same (positive) sign
 * and is >= 0.3; NOT_SUPPORTED if same-day < 0.2 (negative included); otherwise MIXED.
 */
export function evaluateRule(i: RuleInput): { status: VerdictStatus; codes: RuleCode[] } {
  const codes: RuleCode[] = [];
  if (i.n < RULE.minDays) codes.push("N_BELOW_MIN");
  if (i.coverageComplete !== true) codes.push("COVERAGE_NOT_COMPLETE");
  if (i.pearsonPpm === null) codes.push("CORRELATION_UNDEFINED");
  if (codes.length) return { status: "INSUFFICIENT_DATA", codes };
  const r = i.pearsonPpm!;
  const lagOk = i.lagPpm !== null && i.lagPpm > 0n && i.lagPpm >= BigInt(RULE.supportedLagPpm);
  if (i.n >= RULE.supportedMinDays && r >= BigInt(RULE.supportedSameDayPpm) && lagOk)
    return { status: "SUPPORTED", codes: ["MET"] };
  if (r < BigInt(RULE.notSupportedBelowPpm))
    return { status: "NOT_SUPPORTED", codes: ["SAME_DAY_BELOW_FLOOR"] };
  const c: RuleCode[] = ["THRESHOLDS_NOT_ALL_MET"];
  if (i.lagPpm === null) c.push("LAG_UNAVAILABLE");
  return { status: "MIXED", codes: c };
}

/** Exact ratio text of a ppm integer: `294836` -> `0.294836`, `500000` -> `0.5`, `-1000000` -> `-1`. */
export function ppmText(ppm: number | string | bigint): string {
  const v = BigInt(ppm);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const int = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

export const RULE_TEXT =
  `Rule ${RULE_ID} (descriptive; fixed before any run). Input: the two aligned daily series of the run's capsule. ` +
  `INSUFFICIENT_DATA if there are fewer than ${RULE.minDays} aligned days, if the coverage of either panel is not complete for the days used, or if the correlation is undefined. ` +
  `SUPPORTED if there are at least ${RULE.supportedMinDays} aligned days, the same-day Pearson correlation is at least ${ppmText(RULE.supportedSameDayPpm)} and the ${RULE.lagDays}-day-lag correlation is positive and at least ${ppmText(RULE.supportedLagPpm)}. ` +
  `NOT_SUPPORTED if the same-day correlation is below ${ppmText(RULE.notSupportedBelowPpm)} (negative values included). Otherwise MIXED. ` +
  `This is a descriptive correlation rule, not a significance test, and a correlation does not show cause.`;
