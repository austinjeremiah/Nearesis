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

export type VerdictStatus = "SUPPORTED" | "NOT_SUPPORTED" | "MIXED" | "INSUFFICIENT_DATA" | "INVALID_TEST";

export type RuleCode =
  | "N_BELOW_MIN"
  | "COVERAGE_NOT_COMPLETE"
  | "CORRELATION_UNDEFINED"
  | "LAG_UNAVAILABLE"
  | "MET"
  | "SAME_DAY_BELOW_FLOOR"
  | "THRESHOLDS_NOT_ALL_MET"
  | "INVALID_TEST_MECHANICAL"
  | "MET_V2"
  | "POINTS_OTHER_WAY"
  | "INTERVAL_INCLUDES_ZERO_LEVEL_BELOW_FLOOR"
  | "INTERVAL_UNAVAILABLE"
  | "LEVEL_BELOW_SUPPORT"
  | "SIGN_NOT_EXPECTED"
  | "INTERVAL_INCLUDES_ZERO"
  | "CHANGE_UNAVAILABLE"
  | "CHANGE_BELOW_SUPPORT"
  | "CHANGE_SIGN_DIFFERS"
  | "N_BELOW_SUPPORT";

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

// ------------------------------------------------------------------------------------------------------ relationship-v2
export const RULE_V2_ID = "relationship-v2";
export const RULE_V2 = {
  id: RULE_V2_ID,
  lagDays: 7,
  minDays: 30,
  supportedMinDays: 60,
  supportedLevelPpm: 500_000,
  supportedChangePpm: 200_000,
  notSupportedBelowPpm: 200_000,
  bootstrapResamples: 1000,
  bootstrapBlockDays: 7,
  intervalPercent: 95,
} as const;
export type ExpectedSign = "positive" | "negative" | "either";

export interface RuleV2Input {
  /** Aligned pairs used by the primary correlation. */
  n: number;
  levelPpm: bigint | null;
  changePpm: bigint | null;
  interval: { loPpm: bigint; hiPpm: bigint } | null;
  expectedSign: ExpectedSign;
  coverageComplete: boolean | null;
  /** true when the pair is mechanically related (part of a whole, duplicate, numerator of a ratio). */
  mechanical: boolean;
}

const sgn = (v: bigint): number => (v > 0n ? 1 : v < 0n ? -1 : 0);
const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/**
 * Verdict of `relationship-v2`, in this order:
 *  INVALID_TEST: the pair is mechanically related (heuristic detection), whatever the numbers say.
 *  INSUFFICIENT_DATA: fewer than 30 aligned pairs, coverage not complete for the days used, or the level correlation undefined.
 *  NOT_SUPPORTED, "the data point the other way": the plan expects a sign and the 95% interval lies wholly on the other side of 0.
 *  SUPPORTED: at least 60 pairs, the level correlation has the expected sign (any sign when the plan says either) with
 *    |level| >= 0.5, the interval excludes 0 on that side, AND the correlation of day-over-day changes has the same sign
 *    with |change| >= 0.2.
 *  NOT_SUPPORTED: the interval includes 0 and |level| < 0.2.
 *  MIXED: everything else.
 */
export function evaluateRuleV2(i: RuleV2Input): { status: VerdictStatus; codes: RuleCode[] } {
  if (i.mechanical) return { status: "INVALID_TEST", codes: ["INVALID_TEST_MECHANICAL"] };
  const codes: RuleCode[] = [];
  if (i.n < RULE_V2.minDays) codes.push("N_BELOW_MIN");
  if (i.coverageComplete !== true) codes.push("COVERAGE_NOT_COMPLETE");
  if (i.levelPpm === null) codes.push("CORRELATION_UNDEFINED");
  if (codes.length) return { status: "INSUFFICIENT_DATA", codes };
  const r = i.levelPpm!;
  const iv = i.interval;
  const ivExcludesZero = iv !== null && (iv.loPpm > 0n || iv.hiPpm < 0n);
  const ivSide = iv === null ? 0 : iv.loPpm > 0n ? 1 : iv.hiPpm < 0n ? -1 : 0;
  const exp = i.expectedSign === "positive" ? 1 : i.expectedSign === "negative" ? -1 : 0;
  if (exp !== 0 && ivExcludesZero && ivSide === -exp)
    return { status: "NOT_SUPPORTED", codes: ["POINTS_OTHER_WAY"] };
  const s = sgn(r);
  const signOk = exp === 0 ? s !== 0 : s === exp;
  const failing: RuleCode[] = [];
  if (i.n < RULE_V2.supportedMinDays) failing.push("N_BELOW_SUPPORT");
  if (!signOk) failing.push("SIGN_NOT_EXPECTED");
  if (abs(r) < BigInt(RULE_V2.supportedLevelPpm)) failing.push("LEVEL_BELOW_SUPPORT");
  if (iv === null) failing.push("INTERVAL_UNAVAILABLE");
  else if (!ivExcludesZero || ivSide !== s) failing.push("INTERVAL_INCLUDES_ZERO");
  if (i.changePpm === null) failing.push("CHANGE_UNAVAILABLE");
  else {
    if (abs(i.changePpm) < BigInt(RULE_V2.supportedChangePpm)) failing.push("CHANGE_BELOW_SUPPORT");
    if (sgn(i.changePpm) !== s) failing.push("CHANGE_SIGN_DIFFERS");
  }
  if (!failing.length) return { status: "SUPPORTED", codes: ["MET_V2"] };
  if (iv !== null && !ivExcludesZero && abs(r) < BigInt(RULE_V2.notSupportedBelowPpm))
    return { status: "NOT_SUPPORTED", codes: ["INTERVAL_INCLUDES_ZERO_LEVEL_BELOW_FLOOR"] };
  return { status: "MIXED", codes: ["THRESHOLDS_NOT_ALL_MET", ...failing] };
}

export const RULE_V2_TEXT =
  `Rule ${RULE_V2_ID} (descriptive; fixed before any run). Input: the two aligned daily series of the run's capsule and the test plan that names them. ` +
  `INVALID_TEST if the two series are mechanically related (part of a whole, a duplicate, or a ratio whose numerator is the other series; heuristic detection). ` +
  `INSUFFICIENT_DATA if there are fewer than ${RULE_V2.minDays} aligned days, if the coverage of either panel is not complete for the days used, or if the correlation is undefined. ` +
  `SUPPORTED needs at least ${RULE_V2.supportedMinDays} aligned days, a level correlation of the sign the plan expects with absolute value at least ${ppmText(RULE_V2.supportedLevelPpm)}, a ${RULE_V2.intervalPercent}% interval for it that excludes 0, and a correlation of day-over-day changes of the same sign with absolute value at least ${ppmText(RULE_V2.supportedChangePpm)}. ` +
  `NOT_SUPPORTED if the interval includes 0 and the absolute level correlation is below ${ppmText(RULE_V2.notSupportedBelowPpm)}, or if the plan expects a sign and the interval lies wholly on the other side of 0 (the data point the other way). Otherwise MIXED. ` +
  `The interval is a moving-block bootstrap (${RULE_V2.bootstrapBlockDays}-day blocks, ${RULE_V2.bootstrapResamples} resamples, seed from the capsule hash). ` +
  `This is a descriptive rule, not a significance test, and a correlation does not show cause.`;

/** The falsification criterion of a plan, in the terms of the rule. */
export function falsificationOf(expectedSign: ExpectedSign, lagDays: number): string {
  const when = lagDays > 0 ? ` (series paired ${lagDays} days apart)` : "";
  const side = expectedSign === "positive" ? "positive" : expectedSign === "negative" ? "negative" : "either";
  return (
    `The claim fails if, over at least ${RULE_V2.minDays} complete aligned days${when}, the ${RULE_V2.intervalPercent}% interval of the level correlation includes 0 while its absolute value is below ${ppmText(RULE_V2.notSupportedBelowPpm)}, ` +
    (expectedSign === "either"
      ? "or if the day-over-day changes of the two series do not move in the same direction as the levels."
      : `or if the interval lies wholly on the ${expectedSign === "positive" ? "negative" : "positive"} side of 0 (the data point the other way; expected sign ${side}).`)
  );
}
