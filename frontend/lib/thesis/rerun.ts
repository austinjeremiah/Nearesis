import { isCorrelation, readableCorrelation, readableNumber } from './display';

/** View model for the result of `POST /v1/theses/:id/rerun`. Nothing is invented: missing parts stay missing. */
export type RerunOutcome = 'match' | 'drift' | 'different' | 'incomplete';
export type RerunRow = { what: string; original: string | null; reproduced: string | null; delta: string | null; changed: boolean };
export type RerunView = {
  outcome: RerunOutcome | 'unknown';
  banner: string;
  tone: 'ok' | 'warn' | 'bad' | '';
  changed: RerunRow[];
  unchanged: RerunRow[];
  unavailable: { chart: string; reason: string | null }[];
  ranAt: string | null;
  window: { from: string | null; to: string | null } | null;
  charts: number | null;
  queries: number | null;
  receiptId: string | null;
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export const OUTCOME_BANNER: Record<RerunOutcome, string> = {
  match: 'Every number came out the same',
  drift: 'Same verdict, some numbers moved since this was frozen',
  different: 'The verdict or the sample changed',
  incomplete: 'Some queries could not be re-run',
};
const TONE: Record<RerunOutcome, RerunView['tone']> = { match: 'ok', drift: 'warn', different: 'bad', incomplete: 'warn' };

/** A row has changed when its delta is a non-zero number, or, without a numeric delta, when the two values differ. */
export function rowChanged(original: string | null, reproduced: string | null, delta: string | null): boolean {
  if (delta !== null && /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?%?$/.test(delta.trim())) return Number(delta.replace('%', '')) !== 0;
  return (original ?? '').trim() !== (reproduced ?? '').trim();
}

export function rerunView(raw: unknown): RerunView {
  const r = isRec(raw) ? raw : {};
  const o = r.outcome;
  const outcome: RerunView['outcome'] = o === 'match' || o === 'drift' || o === 'different' || o === 'incomplete' ? o : 'unknown';
  const rows: RerunRow[] = [];
  for (const x of Array.isArray(r.rows) ? r.rows : []) {
    if (!isRec(x)) continue;
    const what = text(x.what);
    if (!what) continue;
    const original = text(x.original);
    const reproduced = text(x.reproduced);
    const delta = text(x.delta);
    rows.push({ what, original, reproduced, delta, changed: rowChanged(original, reproduced, delta) });
  }
  const reran = isRec(r.reran) ? r.reran : null;
  const w = reran && isRec(reran.window) ? { from: text(reran.window.from), to: text(reran.window.to) } : null;
  return {
    outcome,
    banner: outcome === 'unknown' ? 'The result could not be read (unknown)' : OUTCOME_BANNER[outcome],
    tone: outcome === 'unknown' ? '' : TONE[outcome],
    changed: rows.filter((x) => x.changed),
    unchanged: rows.filter((x) => !x.changed),
    unavailable: (Array.isArray(r.unavailable) ? r.unavailable : []).filter(isRec).map((u) => ({ chart: text(u.chart) ?? 'unknown', reason: text(u.reason) })),
    ranAt: reran ? text(reran.at) : null,
    window: w,
    charts: reran ? int(reran.charts) : null,
    queries: reran ? int(reran.queries) : null,
    receiptId: text(r.receiptId),
  };
}

/** A table cell: readable number with the exact text kept for the tooltip. */
export const cell = (v: string | null, what = ''): { text: string; exact: string | undefined } =>
  v === null ? { text: 'unknown', exact: undefined } : { text: isCorrelation(what) ? readableCorrelation(v) : readableNumber(v), exact: v };
