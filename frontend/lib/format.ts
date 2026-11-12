import type { MeasureValue } from '@/lib/contracts';

/**
 * Number, date and missingness formatting.
 *
 * Centralised because spec 4.4 turns on a distinction that is easy to lose one
 * screen at a time: an observed zero and an unavailable value must never render
 * the same way. `formatMeasure(0)` is "0" and `formatMeasure(null)` is "—".
 */

/** The single glyph for "no value". Never substitute 0, blank or "N/A". */
export const EM_DASH = '—';

export function formatMeasure(
  value: MeasureValue | undefined,
  opts: { precision?: number; unit?: string; compact?: boolean } = {},
): string {
  if (value === null || value === undefined) return EM_DASH;
  const { precision, unit, compact } = opts;
  const n = new Intl.NumberFormat('en-US', {
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: precision ?? (Math.abs(value) < 10 ? 2 : 0),
    minimumFractionDigits: precision ?? 0,
  }).format(value);
  return unit ? `${n} ${unit}` : n;
}

/** Percentages are stored as 0..1 and shown with an explicit sign where useful. */
export function formatPercent(value: MeasureValue, digits = 1, signed = false): string {
  if (value === null) return EM_DASH;
  const s = (value * 100).toFixed(digits);
  return `${signed && value > 0 ? '+' : ''}${s}%`;
}

/** Money always carries its currency. A missing rate means no monetary total. */
export function formatUsd(value: MeasureValue, digits = 2): string {
  if (value === null) return EM_DASH;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * Spec 4.2 requires the timezone conversion to be visible. Everything is stored
 * UTC and displayed UTC, so the suffix is part of the value, not decoration.
 */
export function formatUtc(iso: string | null, withTime = true): string {
  if (!iso) return EM_DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  const date = d.toISOString().slice(0, 10);
  return withTime ? `${date} ${d.toISOString().slice(11, 16)} UTC` : date;
}

/** Relative age, for freshness indicators. Pairs with the absolute timestamp. */
export function formatAge(iso: string | null, now = Date.now()): string {
  if (!iso) return EM_DASH;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return EM_DASH;
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Hashes are shown head-and-tail so two can be compared at a glance. */
export function shortHash(hash: string, head = 7, tail = 4): string {
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}${'…'}${hash.slice(-tail)}`;
}

/** Coverage as a ratio, or null when the window expected nothing. */
export function coverageRatio(c: { expected: number; observed: number }): number | null {
  if (c.expected <= 0) return null;
  return c.observed / c.expected;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
