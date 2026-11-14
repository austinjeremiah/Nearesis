import { formatUtc, shortHash } from '@/lib/format';
import { CERT_LABEL, certificationOf, coverageInfo, dateRuns, freshnessInfo, toNum, truncationInfo, truncationLabel } from './model';
import type { CanvasPanel, PanelData } from './types';

/**
 * View-model of the "Query and provenance" popup. Pure: it reads only what the panel card already loaded (the canvas
 * panel and its data response) and never invents a value. Anything the response does not carry is `null`, which the
 * popup renders as "not recorded".
 */

export type HashView = { full: string; short: string };
export type ProvenanceView = {
  title: string;
  /** What the query block is: the semantic query spec or the analytics capability call. */
  queryKind: 'semantic' | 'analytics';
  queryLabel: string;
  /** The stored spec exactly as returned, pretty-printed; null when the response carries none. */
  queryText: string | null;
  sources: string[];
  sourceLabel: string | null;
  window: string | null;
  metric: { name: string | null; version: string | null; certification: string; status: string | null };
  coverage: { state: string; lines: string[]; gaps: string[] };
  freshness: { label: string; asOf: string | null; generatedAt: string | null };
  rowCount: number | null;
  rowsNote: string | null;
  resultHash: HashView | null;
  queryHash: HashView | null;
  /** Said under the query block when there is no stored query text. */
  queryNote: string | null;
  caveats: string[];
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const day = (s: string | null) => (s ? s.slice(0, 10) : null);

export const hashView = (full: string): HashView => ({ full, short: shortHash(full) });

/** The window the query asked for: semantic `time.from/to`, or the analytics call's `from` and `to`. */
export function queryWindow(ast: unknown): string | null {
  const a = obj(ast);
  const t = obj(a.time);
  const input = obj(a.input);
  const from = day(str(t.from) ?? str(input.from));
  const to = day(str(t.to) ?? str(input.to));
  if (from && to) return `${from} to ${to}`;
  return null;
}

/** The metric the query reads: semantic measures, or the analytics capability and analysis. */
export function queryMetricName(ast: unknown): string | null {
  const a = obj(ast);
  if (Array.isArray(a.measures) && a.measures.length) {
    const names = a.measures.map((m) => (typeof m === 'string' ? m : str(obj(m).name) ?? str(obj(m).id))).filter((x): x is string => !!x);
    if (names.length) return names.join(', ');
  }
  const cap = str(a.capability);
  if (cap) {
    const analysis = str(obj(a.input).analysis);
    return analysis ? `${cap} (${analysis})` : cap;
  }
  return null;
}

export function buildProvenanceView(panel: CanvasPanel, data: PanelData): ProvenanceView {
  const p = data.provenance;
  const cert = certificationOf(panel, data);
  const cov = coverageInfo(data);
  const fr = freshnessInfo(data);
  const trunc = truncationInfo(data);
  const analytics = data.kind === 'analytics';
  const ast = p?.ast ?? null;
  const lines: string[] = [];
  if (cov.daysRequested !== null) lines.push(`${cov.daysWithData ?? '?'} of ${cov.daysRequested} days have data`);
  const runs = (days: string[]) => dateRuns(days).map(([a, z]) => (a === z ? a : `${a} to ${z}`)).join(', ');
  if (cov.missing.length) lines.push(`No coverage record (unknown, not zero): ${runs(cov.missing)}`);
  if (cov.incomplete.length) lines.push(`Incomplete, counts are lower bounds: ${runs(cov.incomplete)}`);
  if (cov.note) lines.push(cov.note);
  if (trunc) lines.push(truncationLabel(trunc));
  const gaps = data.gaps.map((g) => `${g.from === g.to ? g.from : `${g.from} to ${g.to}`}: ${g.reason}`);
  const w = data.chart?.sourceWatermark ?? data.freshness.sourceWatermark;
  const rowCount = data.chart ? data.chart.rows.length : null;
  const requested = trunc?.requested ?? null;
  const partialCount = toNum(data.partialCount);
  return {
    title: panel.title,
    queryKind: analytics ? 'analytics' : 'semantic',
    queryLabel: analytics ? 'Analytics call' : 'Semantic query',
    queryText: ast === null || ast === undefined ? null : JSON.stringify(ast, null, 2),
    sources: p?.sources ?? [],
    sourceLabel: p?.sourceLabel ?? null,
    window: queryWindow(ast),
    metric: {
      name: queryMetricName(ast) ?? panel.analytics?.label ?? null,
      version: p?.semanticVersion ?? panel.queryRef?.semanticVersion ?? null,
      certification: CERT_LABEL[cert],
      status: data.metricStatus ?? null,
    },
    coverage: { state: cov.state, lines, gaps },
    freshness: { label: fr.label, asOf: w ? formatUtc(w) : null, generatedAt: data.freshness.generatedAt ? formatUtc(data.freshness.generatedAt) : null },
    rowCount,
    rowsNote: requested !== null && rowCount !== null && requested > rowCount ? `of ${trunc?.lowerBound ? 'at least ' : ''}${requested.toLocaleString('en-US')} before truncation` : partialCount ? `${partialCount} partial` : null,
    resultHash: p ? hashView(p.resultHash) : null,
    queryHash: hashView(data.queryHash),
    queryNote: ast === null || ast === undefined ? 'The response carries no stored query text.' : null,
    caveats: data.caveats,
  };
}

/** The subset of a quick-answer chart this view needs (kept structural so this module does not import the agent types). */
export type QuickChartLike = {
  title: string;
  source: string;
  window: { from: string; to: string } | null;
  coverage: string | null;
  metricVersion: string | null;
  caveats: string[];
  rows: unknown[][];
  kind: string;
};

/** A quick answer's chart carries source, window, coverage, metric version and caveats, but not its query: say so. */
export function buildQuickChartView(c: QuickChartLike): ProvenanceView {
  return {
    title: c.title,
    queryKind: 'semantic',
    queryLabel: 'Query',
    queryText: null,
    queryNote: 'A quick answer does not keep its query text, so none is shown. Ask the agent to build a workspace to get a stored, re-runnable query.',
    sources: c.source ? [c.source] : [],
    sourceLabel: null,
    window: c.window ? `${c.window.from} to ${c.window.to}` : null,
    metric: { name: null, version: c.metricVersion, certification: c.metricVersion ? `Metric ${c.metricVersion}` : 'Certification not reported', status: null },
    coverage: { state: c.coverage ?? 'unknown', lines: [], gaps: [] },
    freshness: { label: c.window ? `Data through ${c.window.to}` : 'Not reported', asOf: c.window ? c.window.to : null, generatedAt: null },
    rowCount: c.kind === 'table' ? c.rows.length : null,
    rowsNote: null,
    resultHash: null,
    queryHash: null,
    caveats: c.caveats,
  };
}
