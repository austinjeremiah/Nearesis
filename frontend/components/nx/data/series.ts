import { toNum } from '@/lib/data/num';

/**
 * Period arithmetic for dashboard tiles. Every helper returns null rather than a
 * number the data does not support: a missing day, a null value or a day the API
 * marked incomplete makes the comparison unavailable, never a zero.
 */

export type DayPoint = { x: string; y: string | number | null | undefined };

const DAY_MS = 86_400_000;
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}/.test(s);
const dayMs = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`);

export type PeriodChange = { current: number; previous: number; pct: number | null; days: number };

/**
 * Sum of the last `n` days against the `n` days before them. Returns null unless
 * both periods are fully present: 2n consecutive UTC days, every value known and
 * none of them listed in `excluded` (incomplete or missing days). `pct` is null
 * when the previous total is not above zero, because a ratio to zero is undefined.
 */
export function periodChange(points: DayPoint[], n: number, excluded: ReadonlySet<string> = new Set()): PeriodChange | null {
  if (n < 1 || points.length < 2 * n) return null;
  const tail = points.slice(-2 * n);
  let cur = 0;
  let prev = 0;
  for (let i = 0; i < tail.length; i++) {
    const p = tail[i];
    if (!isDay(p.x) || excluded.has(p.x.slice(0, 10))) return null;
    if (i > 0 && dayMs(p.x) - dayMs(tail[i - 1].x) !== DAY_MS) return null;
    const v = toNum(p.y);
    if (v === null) return null;
    if (i < n) prev += v;
    else cur += v;
  }
  return { current: cur, previous: prev, pct: prev > 0 ? ((cur - prev) / prev) * 100 : null, days: n };
}

/** Mean of the known values in the last `n` points, or null when there are none. `count` is how many were known. */
export function tailMean(points: DayPoint[], n: number): { mean: number; count: number } | null {
  const vals = points.slice(-n).map((p) => toNum(p.y)).filter((v): v is number => v !== null);
  if (!vals.length) return null;
  return { mean: vals.reduce((a, b) => a + b, 0) / vals.length, count: vals.length };
}

/** Sum of the known values in the last `n` points, with how many were known; null when none are. */
export function tailSum(points: DayPoint[], n: number): { sum: number; count: number } | null {
  const vals = points.slice(-n).map((p) => toNum(p.y)).filter((v): v is number => v !== null);
  if (!vals.length) return null;
  return { sum: vals.reduce((a, b) => a + b, 0), count: vals.length };
}
