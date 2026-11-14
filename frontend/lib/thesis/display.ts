/**
 * Display helpers for the thesis viewer. Display only: the exact value is kept by the caller (a `title` tooltip).
 * Dates, hashes and ids never match the number pattern and pass through untouched.
 */

const NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;
const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A plain-string number made readable; anything else is returned as it came. */
export function readableNumber(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return 'unknown';
  const s = typeof v === 'number' ? String(v) : v.trim();
  if (!NUMBER.test(s)) return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  // Integers keep every digit; only large ones gain separators.
  if (INTEGER.test(s)) return Math.abs(n) >= 10000 ? (n < 0 ? '-' : '') + group(String(Math.abs(n))) : String(n);
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs < 1) return String(Number(n.toPrecision(4)));
  const [i, f] = abs.toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}${group(i!)}${f === '00' ? '' : `.${f}`}`;
}

/** A correlation to 3 decimals. */
export function readableCorrelation(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return 'unknown';
  const s = String(v).trim();
  if (!NUMBER.test(s)) return s;
  return Number(Number(s).toFixed(3)).toFixed(3).replace(/^-0\.000$/, '0.000');
}

export type Plain = { label: string; technical: string | null };

const SAME_DAY = 'How closely they move together on the same day (−1 to 1)';
const LAG7 = "How closely this week's first series tracks next week's second (−1 to 1)";
const MAE = 'Forecast error (lower is better)';

/** Is this label or unit a correlation (so its value shows to 3 decimals)? */
export const isCorrelation = (label: string, unit?: string | null): boolean => /pearson|correlation/i.test(label) || /pearson|correlation/i.test(unit ?? '');

/**
 * A plain-language label for a technical one, with the technical name kept as the sub-label.
 * Labels that are already plain come back unchanged with no technical sub-label.
 */
export function plainLabel(label: string, unit?: string | null): Plain {
  const l = label.trim();
  const lag = /\blag(?:\s+of)?\s+(\d+)/i.exec(l) ?? /\b(\d+)[- ]day[- ]lag/i.exec(l);
  if (lag && /pearson|correlation|lag/i.test(l)) {
    const d = Number(lag[1]);
    return { label: d === 7 ? LAG7 : `How closely the first series tracks the second ${d} days later (−1 to 1)`, technical: l };
  }
  if (/same[- ]day/i.test(l) && /pearson|correlation/i.test(l)) return { label: SAME_DAY, technical: l };
  if (/^pearson/i.test(l)) return { label: SAME_DAY, technical: l };
  if (/\bMAE\b/.test(l) && /log scale/i.test(unit ?? l)) return { label: l, technical: null };
  return { label: l, technical: null };
}

/** The unit as a plain phrase plus its technical name ("MAE, log scale" becomes the forecast-error phrase). */
export function plainUnit(unit: string | null | undefined): Plain | null {
  if (!unit) return null;
  if (/^MAE\b/i.test(unit)) return { label: MAE, technical: unit };
  if (/^ratio$/i.test(unit)) return null;
  return { label: unit, technical: null };
}

/** Provenance pointers like "[results.json#/pearson_ppm]" read as noise in prose; a workspace thesis' text is shown without them. */
export const stripRefs = (text: string): string => text.replace(/(?:[ \t]*\[[\w./-]+\.json#[^\]\n]*\])+/g, '');

/** The verdict headline without the status word it starts with: the badge already says it ("SUPPORTED: SUPPORTED: x" becomes "x"). */
export function stripStatusPrefix(headline: string | null | undefined, status?: string | null): string | null {
  if (!headline) return null;
  let h = headline.trim();
  const words = new Set(['SUPPORTED', 'NOT_SUPPORTED', 'MIXED', 'INSUFFICIENT_DATA']);
  if (status) words.add(status.toUpperCase().replace(/\s+/g, '_'));
  for (let i = 0; i < 4; i += 1) {
    const m = /^([A-Za-z_ ]{3,30}?):\s+/.exec(h);
    if (!m || !words.has(m[1]!.trim().toUpperCase().replace(/\s+/g, '_'))) break;
    h = h.slice(m[0].length);
  }
  return h || headline.trim();
}
