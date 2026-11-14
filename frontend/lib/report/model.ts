import type { ReportDoc, ReportFinding, ReportPanel, ReportRun } from './types';

/** Rows drawn in a report table. Everything past this is stated as "n more rows", never silently dropped. */
export const TABLE_ROW_CAP = 25;

export type Pt = { x: string; y: number | null };
export type PanelDraw =
  | { type: 'line' | 'bar'; x: string[]; series: { name: string; unit: string | null; points: Pt[] }[]; xName: string; rowCount: number }
  | { type: 'table'; columns: { name: string; unit: string | null }[]; rows: (string | number | null)[][]; more: number; rowCount: number }
  | { type: 'none'; reason: string };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Chart axis label for a day-grain ISO timestamp; anything else is shown as it came. */
export function axisLabel(x: unknown): string {
  const s = String(x ?? '');
  return /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(s) ? s.slice(0, 10) : s;
}

/**
 * What to draw for one panel, from its own data. Line and bar panels draw the columns their canvas encoding names (else every
 * measure column of the first measure's unit); a null cell stays a null point (a gap), never 0. A panel with no usable
 * x/y pair, or of another kind, is drawn as a capped table of its rows.
 */
export function panelDraw(p: ReportPanel): PanelDraw {
  const chart = p.data?.chart;
  if (!p.data) return { type: 'none', reason: p.error ? `The data could not be read (${p.error.reasonCode}).` : 'No data was returned.' };
  if (p.data.cannotCompute) return { type: 'none', reason: p.data.cannotCompute.explanation };
  if (!chart || chart.columns.length === 0 || chart.rows.length === 0) return { type: 'none', reason: 'The query returned no rows.' };
  const cols = chart.columns;
  const rows = chart.rows;
  const xName = p.encoding?.x && cols.some((c) => c.name === p.encoding!.x) ? p.encoding.x : cols[0]!.name;
  const xi = cols.findIndex((c) => c.name === xName);
  const kind = p.kind === 'bar' ? 'bar' : p.kind === 'timeSeries' || p.kind === 'line' ? 'line' : null;
  let ys = (p.encoding?.y ?? []).map((n) => cols.findIndex((c) => c.name === n)).filter((i) => i >= 0 && i !== xi);
  if (ys.length === 0) {
    const numeric = cols.map((_, i) => i).filter((i) => i !== xi && rows.some((r) => num(r[i]) !== null));
    const first = numeric[0];
    ys = first === undefined ? [] : numeric.filter((i) => cols[i]!.unit === cols[first]!.unit);
  }
  if (kind && ys.length > 0 && ys.length <= 6) {
    return {
      type: kind,
      xName,
      rowCount: rows.length,
      x: rows.map((r) => axisLabel(r[xi])),
      series: ys.map((i) => ({ name: cols[i]!.name, unit: cols[i]!.unit, points: rows.map((r) => ({ x: axisLabel(r[xi]), y: num(r[i]) })) })),
    };
  }
  return { type: 'table', columns: cols, rows: rows.slice(0, TABLE_ROW_CAP), more: Math.max(0, rows.length - TABLE_ROW_CAP), rowCount: rows.length };
}

/** The same panel's rows as a capped table (used under a chart when it is short enough to be useful). */
export function panelTable(p: ReportPanel, cap = TABLE_ROW_CAP): { columns: { name: string; unit: string | null }[]; rows: (string | number | null)[][]; more: number } | null {
  const c = p.data?.chart;
  if (!c || c.rows.length === 0) return null;
  return { columns: c.columns, rows: c.rows.slice(0, cap), more: Math.max(0, c.rows.length - cap) };
}

const STATUS_RANK: Record<string, number> = { supported: 0, mixed: 1, insufficient_data: 2, cannot_compute: 3 };

/**
 * Executive summary built only from text that already passed grounding: the findings' own statements. No new sentence is
 * written. Per question, findings the data supports come first; at most 2 per question and 8 overall.
 */
export function executiveSummary(runs: ReportRun[]): { runId: string; question: string | null; finding: ReportFinding }[] {
  const out: { runId: string; question: string | null; finding: ReportFinding }[] = [];
  for (const r of runs) {
    const fs = [...r.interpretation.findings].sort((a, b) => (STATUS_RANK[a.status ?? ''] ?? 9) - (STATUS_RANK[b.status ?? ''] ?? 9));
    for (const f of fs.slice(0, 2)) out.push({ runId: r.id, question: r.question, finding: f });
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
}

/** Panels a run section draws: the run's own hashes, in order, that the report holds. */
export function panelsOfRun(run: ReportRun, panels: ReportPanel[]): ReportPanel[] {
  const by = new Map(panels.map((p) => [p.hash, p]));
  return run.panelHashes.map((h) => by.get(h)).filter((p): p is ReportPanel => !!p);
}

export function panelTitle(p: ReportPanel): string {
  if (p.title) return p.title;
  const ys = p.encoding?.y?.[0] ?? p.data?.chart?.columns[1]?.name;
  return ys ? ys : `Panel ${p.hash.slice(0, 8)}`;
}

export const shortWid = (wid: string): string => wid.replace(/-/g, '').slice(0, 8);

export function pdfFilename(wid: string, now = new Date()): string {
  return `nearesis-report-${shortWid(wid)}-${now.toISOString().slice(0, 10)}.pdf`;
}

export const nearblocksTx = (hash: string): string => `https://testnet.nearblocks.io/txns/${hash}`;

/** True when the document has anything to say beyond the cover (used for the empty-workspace notice). */
export function hasContent(d: ReportDoc): boolean {
  return d.runs.length + d.hypotheses.length + d.markers.length + d.monitors.length + d.capsules.length > 0;
}

/** "n more rows" wording shared by tables and the tests. */
export const moreRows = (n: number): string => `${n.toLocaleString('en-US')} more row${n === 1 ? '' : 's'} not shown`;
