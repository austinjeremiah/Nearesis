import type { MeasureValue } from '@/lib/contracts';

/**
 * Deterministic series generation for the frozen fixture snapshot.
 *
 * Seeded rather than random for two reasons. A fixture that changes between the
 * server render and the client render is a hydration mismatch, and a snapshot
 * whose numbers move on reload cannot demonstrate the one thing this product
 * claims: that the same snapshot produces the same tables.
 */

/** mulberry32. Small, fast, and stable across runtimes. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Point = [string, MeasureValue];

/**
 * A daily series ending at `endIso`.
 *
 * `gaps` are UTC dates that produce null rather than a number: the fixture
 * carries real missingness so the UI's "—" path, coverage chips and
 * break-the-line rendering are exercised instead of being dead code.
 */
export function dailySeries(opts: {
  seed: number;
  days: number;
  endIso: string;
  start: number;
  /** Compound daily drift, e.g. 0.004 for a slow climb. */
  drift?: number;
  /** Relative noise amplitude. */
  noise?: number;
  /** Weekly seasonality amplitude, as a fraction of level. */
  weekly?: number;
  /** UTC dates (YYYY-MM-DD) that are unavailable rather than zero. */
  gaps?: string[];
  /** A one-off level shift from this date onward, e.g. a regime change. */
  shift?: { from: string; factor: number };
  integer?: boolean;
}): Point[] {
  const {
    seed,
    days,
    endIso,
    start,
    drift = 0,
    noise = 0.08,
    weekly = 0,
    gaps = [],
    shift,
    integer = true,
  } = opts;

  const r = rng(seed);
  const end = new Date(endIso);
  const out: Point[] = [];
  let level = start;

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);

    level *= 1 + drift;
    const season = weekly ? 1 + weekly * Math.sin((d.getUTCDay() / 7) * Math.PI * 2) : 1;
    const jitter = 1 + (r() - 0.5) * 2 * noise;
    const regime = shift && iso >= shift.from ? shift.factor : 1;

    if (gaps.includes(iso)) {
      out.push([iso, null]);
      continue;
    }
    const v = level * season * jitter * regime;
    out.push([iso, integer ? Math.round(v) : Number(v.toFixed(4))]);
  }
  return out;
}

/** Drop the nulls. For charts that break the line rather than shading a gap. */
export function compact(points: Point[]): [string, number][] {
  return points.filter((p): p is [string, number] => p[1] !== null);
}

/** Sum ignoring unavailable days. The caller must label the result PARTIAL. */
export function sum(points: Point[]): number {
  return points.reduce((a, p) => a + (p[1] ?? 0), 0);
}

export function lastValue(points: Point[]): MeasureValue {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i][1] !== null) return points[i][1];
  }
  return null;
}

/** Period-over-period change, or null when either side is unavailable. */
export function changeOverWindow(points: Point[], window: number): MeasureValue {
  const vals = compact(points);
  if (vals.length < window * 2) return null;
  const recent = vals.slice(-window).reduce((a, p) => a + p[1], 0);
  const prior = vals.slice(-window * 2, -window).reduce((a, p) => a + p[1], 0);
  if (prior === 0) return null;
  return (recent - prior) / prior;
}
