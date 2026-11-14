import { describe, expect, it } from 'vitest';
import { TABLE_ROW_CAP, axisLabel, executiveSummary, moreRows, panelDraw, panelTitle, panelsOfRun, pdfFilename, shortWid } from '@/lib/report/model';
import type { ReportFinding, ReportPanel, ReportRun } from '@/lib/report/types';

const panel = (o: Partial<ReportPanel> & { rows?: (string | number | null)[][]; columns?: { name: string; unit: string | null }[] }): ReportPanel => ({
  hash: 'a'.repeat(64),
  title: 'Daily swaps',
  kind: 'timeSeries',
  encoding: null,
  unit: null,
  source: null,
  window: null,
  metricVersion: null,
  coverage: null,
  caveats: [],
  gaps: [],
  runIds: [],
  error: null,
  data: {
    chart: {
      columns: o.columns ?? [{ name: 'day', unit: null }, { name: 'swaps', unit: 'swaps' }],
      rows: o.rows ?? [['2026-01-01T00:00:00.000Z', 5], ['2026-01-02T00:00:00.000Z', null]],
    },
  },
  ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'rows' && k !== 'columns')),
});

describe('panelDraw', () => {
  it('draws a time series and keeps a null as a gap, never zero', () => {
    const d = panelDraw(panel({}));
    expect(d.type).toBe('line');
    if (d.type !== 'line') return;
    expect(d.x).toEqual(['2026-01-01', '2026-01-02']);
    expect(d.series[0]!.points.map((p) => p.y)).toEqual([5, null]);
  });
  it('draws only the columns the canvas encoding names', () => {
    const d = panelDraw(
      panel({
        encoding: { x: 'period', y: ['rate'] },
        columns: [{ name: 'period', unit: null }, { name: 'swaps', unit: 'swaps' }, { name: 'rate', unit: 'ratio' }],
        rows: [['2026-01-01', 10, 0.1]],
      }),
    );
    expect(d.type).toBe('line');
    if (d.type === 'line') expect(d.series.map((s) => s.name)).toEqual(['rate']);
  });
  it('falls back to the measures that share the first measure unit', () => {
    const d = panelDraw(
      panel({
        columns: [{ name: 'd', unit: null }, { name: 'a', unit: 'swaps' }, { name: 'b', unit: 'usd' }, { name: 'c', unit: 'swaps' }],
        rows: [['2026-01-01', 1, 2, 3]],
      }),
    );
    if (d.type === 'line') expect(d.series.map((s) => s.name)).toEqual(['a', 'c']);
    else throw new Error('expected a line');
  });
  it('a table panel is capped and says how many rows are left out', () => {
    const rows = Array.from({ length: TABLE_ROW_CAP + 7 }, (_, i) => [`r${i}`, i]);
    const d = panelDraw(panel({ kind: 'table', rows }));
    expect(d.type).toBe('table');
    if (d.type === 'table') {
      expect(d.rows).toHaveLength(TABLE_ROW_CAP);
      expect(d.more).toBe(7);
      expect(d.rowCount).toBe(TABLE_ROW_CAP + 7);
    }
    expect(moreRows(7)).toBe('7 more rows not shown');
    expect(moreRows(1)).toBe('1 more row not shown');
  });
  it('states why nothing is drawn instead of inventing a chart', () => {
    expect(panelDraw(panel({ data: null, error: { status: 404, reasonCode: 'QUERY_UNKNOWN' } }))).toEqual({ type: 'none', reason: 'The data could not be read (QUERY_UNKNOWN).' });
    expect(panelDraw(panel({ rows: [] })).type).toBe('none');
    expect(panelDraw(panel({ data: { chart: null, cannotCompute: { explanation: 'Source gone.' } } }))).toEqual({ type: 'none', reason: 'Source gone.' });
  });
});

describe('labels and names', () => {
  it('axisLabel shortens only midnight UTC timestamps', () => {
    expect(axisLabel('2026-08-14T00:00:00.000Z')).toBe('2026-08-14');
    expect(axisLabel('2026-08-14T05:00:00.000Z')).toBe('2026-08-14T05:00:00.000Z');
    expect(axisLabel('near->eth')).toBe('near->eth');
  });
  it('panelTitle prefers the title, then the encoded column, then the hash', () => {
    expect(panelTitle(panel({}))).toBe('Daily swaps');
    expect(panelTitle(panel({ title: null, encoding: { y: ['refundRate'] } }))).toBe('refundRate');
    expect(panelTitle(panel({ title: null, data: null }))).toBe('Panel aaaaaaaa');
  });
  it('pdf filename carries the short workspace id and the date', () => {
    const wid = 'f7daa0ad-96a9-4207-8009-7eb01e4d86bc';
    expect(shortWid(wid)).toBe('f7daa0ad');
    expect(pdfFilename(wid, new Date('2026-11-14T10:00:00Z'))).toBe('nearesis-report-f7daa0ad-2026-11-14.pdf');
  });
});

const finding = (id: string, status: string): ReportFinding => ({ id, statement: `s-${id}`, status, panelHashes: [] });
const run = (id: string, fs: ReportFinding[], hashes: string[] = []): ReportRun => ({
  id,
  question: `q-${id}`,
  state: 'COMPLETE',
  terminal: true,
  source: 'live',
  createdAt: null,
  updatedAt: null,
  budget: null,
  interpretation: { state: 'ready', reason: null, findingCount: fs.length, summary: null, findings: fs },
  panelHashes: hashes,
});

describe('executiveSummary', () => {
  it('quotes findings verbatim, supported first, at most 2 per question and 8 overall', () => {
    const s = executiveSummary([run('r1', [finding('a', 'insufficient_data'), finding('b', 'supported'), finding('c', 'mixed')])]);
    expect(s.map((x) => x.finding.id)).toEqual(['b', 'c']);
    const many = executiveSummary(Array.from({ length: 6 }, (_, i) => run(`r${i}`, [finding(`x${i}`, 'mixed'), finding(`y${i}`, 'mixed')])));
    expect(many).toHaveLength(8);
  });
  it('is empty when there is no finding (no sentence is invented)', () => {
    expect(executiveSummary([run('r1', [])])).toEqual([]);
    expect(executiveSummary([])).toEqual([]);
  });
});

describe('panelsOfRun', () => {
  it('returns the run panels in order and skips hashes the report does not hold', () => {
    const p1 = panel({ hash: '1'.repeat(64) });
    const p2 = panel({ hash: '2'.repeat(64) });
    expect(panelsOfRun(run('r', [], ['2'.repeat(64), '9'.repeat(64), '1'.repeat(64)]), [p1, p2])).toEqual([p2, p1]);
  });
});
