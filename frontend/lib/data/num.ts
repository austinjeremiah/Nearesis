import { EM_DASH } from '@/lib/format';

/**
 * Number display for analytics responses. The API sends exact decimals as
 * strings; null or undefined means "not available" and renders as an em dash,
 * never as 0. Only presentation rounds here; no arithmetic is done on money.
 */
type N = string | number | null | undefined;

export function toNum(v: N): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function fInt(v: N): string {
  const n = toNum(v);
  return n === null ? EM_DASH : new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
}

export function fCompact(v: N): string {
  const n = toNum(v);
  return n === null ? EM_DASH : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
}

export function fDec(v: N, digits = 2): string {
  const n = toNum(v);
  return n === null ? EM_DASH : new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(n);
}

/** A 0..1 ratio as a percentage. */
export function fPct(v: N, digits = 1): string {
  const n = toNum(v);
  return n === null ? EM_DASH : `${(n * 100).toFixed(digits)}%`;
}

/** A value already in percent (for example growthPct "6.26"). */
export function fPctPoints(v: N, digits = 1): string {
  const n = toNum(v);
  return n === null ? EM_DASH : `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

/** USD known amount. The label "known" travels with it in column headers. */
export function fUsd(v: N, compact = true): string {
  const n = toNum(v);
  if (n === null) return EM_DASH;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 2 : 0,
  }).format(n);
}

export function fMs(v: N): string {
  const n = toNum(v);
  if (n === null) return EM_DASH;
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 120_000) return `${(n / 1000).toFixed(1)} s`;
  return `${(n / 60_000).toFixed(1)} min`;
}

export function fSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined) return EM_DASH;
  if (s < 120) return `${s.toFixed(1)} s`;
  if (s < 7200) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}
