import { add, cmp, div, format, mul, parse, ZERO, type D } from "./dec.ts";

export interface ShareRow {
  key: string;
  value: string;
}

/**
 * Concentration of a non-negative measure over known groups. Shares and HHI are exact:
 *   share_i = v_i / V;  HHI = 10000 * sum(v_i^2) / V^2  (4 digits);  topN share = sum of the N largest v_i / V.
 * Returns null total/shares/hhi when V is zero: an empty population has no concentration, it is not "0".
 */
export function concentration(rows: ShareRow[], topN: number) {
  const vals = rows
    .map((r) => ({ key: r.key, v: parse(r.value) }))
    .filter((r) => cmp(r.v, ZERO) > 0)
    .sort((a, b) => cmp(b.v, a.v) || a.key.localeCompare(b.key));
  const total = vals.reduce<D>((a, r) => add(a, r.v), ZERO);
  if (vals.length === 0)
    return {
      groups: 0,
      total: null,
      hhi: null,
      topNShare: null,
      top: [] as Array<{ key: string; value: string; share: string }>,
    };
  const sq = vals.reduce<D>((a, r) => add(a, mul(r.v, r.v)), ZERO);
  const hhi = format(div(mul(sq, { int: 10000n, scale: 0 }), mul(total, total), 4));
  const topSum = vals.slice(0, topN).reduce<D>((a, r) => add(a, r.v), ZERO);
  return {
    groups: vals.length,
    total: format(total),
    hhi,
    topNShare: format(div(topSum, total, 6)),
    top: vals
      .slice(0, topN)
      .map((r) => ({ key: r.key, value: format(r.v), share: format(div(r.v, total, 6)) })),
  };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

export interface Anomaly {
  day: string;
  value: number;
  baselineMedian: number;
  score: number;
  direction: "up" | "down";
}

export const UNUSUAL_METHOD = {
  name: "modified_z_score_vs_trailing_median",
  reference:
    "Iglewicz and Hoaglin (1993): M = 0.6745 * (x - median) / MAD; |M| > 3.5 flags a potential outlier",
  fallback:
    "if MAD = 0, M = (x - median) / (1.253314 * meanAbsDev); if that is 0 too the series is not scoreable",
  guards:
    "baseline needs >= minBaselineDays complete days and median >= minBaselineMedian; a flagged day also needs |x - median| >= minAbsDelta",
  zeroFill:
    "days with no rows count as 0 only when the day's coverage is complete; partial or missing days are excluded, never zero-filled",
  threshold: 3.5,
} as const;

export interface UnusualOpts {
  threshold?: number;
  minBaselineDays?: number;
  minBaselineMedian?: number;
  minAbsDelta?: number;
}

/** Flags recent days that deviate from the baseline distribution. Pure statistics on counts/volumes; inputs are complete days only. */
export function detectUnusual(
  baseline: number[],
  recent: Array<{ day: string; value: number }>,
  o: UnusualOpts = {},
): {
  scoreable: boolean;
  reason?: string;
  baselineMedian: number | null;
  mad: number | null;
  anomalies: Anomaly[];
} {
  const threshold = o.threshold ?? UNUSUAL_METHOD.threshold;
  const minDays = o.minBaselineDays ?? 14;
  const minMedian = o.minBaselineMedian ?? 5;
  const minDelta = o.minAbsDelta ?? 10;
  if (baseline.length < minDays)
    return {
      scoreable: false,
      reason: `baseline has ${baseline.length} complete days, needs ${minDays}`,
      baselineMedian: null,
      mad: null,
      anomalies: [],
    };
  const med = median(baseline);
  if (med < minMedian)
    return {
      scoreable: false,
      reason: `baseline median ${med} below minimum ${minMedian}`,
      baselineMedian: med,
      mad: null,
      anomalies: [],
    };
  const mad = median(baseline.map((x) => Math.abs(x - med)));
  const meanAd = baseline.reduce((a, x) => a + Math.abs(x - med), 0) / baseline.length;
  if (mad === 0 && meanAd === 0)
    return {
      scoreable: false,
      reason: "baseline has no dispersion",
      baselineMedian: med,
      mad,
      anomalies: [],
    };
  const score = (x: number): number =>
    mad > 0 ? (0.6745 * (x - med)) / mad : (x - med) / (1.253314 * meanAd);
  const anomalies: Anomaly[] = [];
  for (const r of recent) {
    const s = score(r.value);
    if (Math.abs(s) >= threshold && Math.abs(r.value - med) >= minDelta)
      anomalies.push({
        day: r.day,
        value: r.value,
        baselineMedian: med,
        score: Math.round(s * 100) / 100,
        direction: s > 0 ? "up" : "down",
      });
  }
  return { scoreable: true, baselineMedian: med, mad, anomalies };
}
