import { describe, expect, it } from 'vitest';
import { buildOption, coverageInfo, dateRuns, fillGaps, fmtValue, stepMs, toNum, truncationInfo, truncationLabel, certificationOf, availableViz, describeChart } from '@/lib/panel/model';
import { inverse, ordered, resize, spanOf, swapWithNeighbour, previewDoc } from '@/lib/panel/edit';
import type { CanvasDocument, CanvasPanel, PanelData } from '@/lib/panel/types';

const T = { accent: '#0f0', ink: '#000', text2: '#444', text3: '#777', line: '#ddd', lineStrong: '#999', surface: '#fff', warn: '#a60', bad: '#a00', info: '#05a', mono: 'm', font: 'f' };
const panel = (over: Partial<CanvasPanel> = {}): CanvasPanel => ({ panelId: 'p1', kind: 'timeSeries', title: 'T', layout: { x: 0, y: 0, w: 6, h: 6 }, encoding: { x: 'd', y: ['v'] }, ...over });
const data = (rows: (string | number | null)[][], over: Partial<PanelData> = {}): PanelData =>
  ({
    kind: 'semantic', workspaceId: 'w', queryHash: 'h', state: 'complete', gaps: [], coverage: null, caveats: [], cannotCompute: null,
    freshness: { state: 'fresh', sourceWatermark: null, sourceWatermarks: {}, generatedAt: null }, rollupFreshness: null, cost: null, nullCount: null, partialCount: null, provenance: null,
    shape: { queryHash: 'h', grain: 'day', fields: [{ name: 'd', unit: null, role: 'time' }, { name: 'v', unit: 'tx', role: 'measure' }] },
    chart: { panelId: 'x', queryHash: 'h', dataRevision: 1, columns: [{ name: 'd', unit: null }, { name: 'v', unit: 'tx' }], rows, downsampling: { method: 'none', originalPoints: rows.length }, freshness: 'fresh', sourceWatermark: null },
    ...over,
  }) as unknown as PanelData;

describe('values', () => {
  it('parses decimal strings and rejects junk', () => {
    expect(toNum('12.5')).toBe(12.5);
    expect(toNum('')).toBeNull();
    expect(toNum(null)).toBeNull();
    expect(toNum('abc')).toBeNull();
  });
  it('never renders null as zero', () => {
    expect(fmtValue(null, 'tx')).toBe('—');
    expect(fmtValue(0.25, 'ratio')).toBe('25%');
  });
});

describe('gaps', () => {
  it('inserts nulls for missing days, not zeros or interpolation', () => {
    const d = 86_400_000;
    const { points, inserted } = fillGaps([[0, 1], [3 * d, 4]], d);
    expect(inserted).toBe(2);
    expect(points.map((p) => p[1])).toEqual([1, null, null, 4]);
  });
  it('infers a daily step', () => {
    const d = 86_400_000;
    expect(stepMs(undefined, [0, d, 2 * d])).toBe(d);
    expect(stepMs(undefined, [0, 5])).toBeNull();
  });
  it('merges consecutive dates into runs', () => {
    expect(dateRuns(['2026-01-01', '2026-01-02', '2026-01-05'])).toEqual([['2026-01-01', '2026-01-02'], ['2026-01-05', '2026-01-05']]);
  });
  it('a time series with a missing day has a null point and the chart reports a gap', () => {
    const d = data([['2026-01-01T00:00:00.000Z', 1], ['2026-01-02T00:00:00.000Z', null], ['2026-01-04T00:00:00.000Z', 3]]);
    const b = buildOption({ panel: panel(), data: d, viz: 'line', theme: T, palette: ['#0f0'] });
    expect(b.supported).toBe(true);
    const s = (b.option.series as { data: unknown[] }[])[0].data as [number, number | null][];
    expect(s.map((p) => (Array.isArray(p) ? p[1] : (p as unknown as { value: [number, number | null] }).value[1]))).toEqual([1, null, null, 3]);
    expect(b.gaps).toBe(2);
  });
});

describe('coverage and states', () => {
  it('reads analytics coverage lists', () => {
    const c = coverageInfo(data([], { kind: 'analytics', coverage: { state: 'partial', daysRequested: 10, daysWithData: 8, missingDays: ['2026-01-01'], incompleteDays: ['2026-01-05'], note: 'x' } as never }));
    expect(c.missing).toEqual(['2026-01-01']);
    expect(c.incomplete).toEqual(['2026-01-05']);
    expect(c.state).toBe('partial');
  });
  it('reads semantic per-row coverage', () => {
    const d = data([['2026-01-01T00:00:00Z', 1], ['2026-01-02T00:00:00Z', 2]], { coverage: { rowCoverage: ['complete', 'partial'], nullCount: 0, partialCount: 1 } as never });
    expect(coverageInfo(d).incomplete).toEqual(['2026-01-02']);
  });
  it('labels analytics results as not certified', () => {
    expect(certificationOf(panel(), data([], { kind: 'analytics' }))).toBe('analytics');
    expect(certificationOf(panel(), data([], { provenance: { certification: 'certified' } as never }))).toBe('certified');
    expect(certificationOf(panel(), data([], { provenance: { certification: 'experimental' } as never }))).toBe('exploratory');
    expect(certificationOf(panel(), data([], { provenance: { certification: 'partial' } as never }))).toBe('certified');
    expect(certificationOf(panel(), data([], { provenance: { certification: 'certified' } as never, metricStatus: 'draft' }))).toBe('exploratory');
  });
  it('labels truncation with its method', () => {
    const d = data([['2026-01-01', 1]], { state: 'truncated' });
    const t = truncationInfo(d)!;
    expect(truncationLabel(t)).toMatch(/Truncated/);
    const lt = data([['2026-01-01', 1]]);
    lt.chart!.truncation = { truncated: true, reason: 'MAX_ROWS', method: 'lttb', requestedRows: 500, returnedRows: 1, maxRows: 1 } as never;
    expect(truncationLabel(truncationInfo(lt)!)).toMatch(/LTTB/);
  });
});

describe('viz selection', () => {
  it('offers area for time series and stacked for a series encoding', () => {
    expect(availableViz(panel(), undefined)).toEqual(['line', 'area', 'table']);
    expect(availableViz(panel({ kind: 'bar', encoding: { x: 'd', y: ['v'], series: 's' } }), undefined)).toContain('stacked');
  });
  it('draws a heatmap with empty cells for nulls', () => {
    const d = data([['a', 'x', 1], ['b', 'x', null]], {
      shape: { fields: [{ name: 'c', unit: null, role: 'dimension' }, { name: 'r', unit: null, role: 'dimension' }, { name: 'v', unit: 'ratio', role: 'measure' }] } as never,
    });
    d.chart!.columns = [{ name: 'c', unit: null }, { name: 'r', unit: null }, { name: 'v', unit: 'ratio' }];
    const b = buildOption({ panel: panel({ kind: 'cohort', encoding: { x: 'c', y: ['v'], series: 'r' } }), data: d, viz: 'heatmap', theme: T, palette: [] });
    expect(b.supported).toBe(true);
    expect((b.option.series as { data: unknown[] }[])[0].data).toHaveLength(1);
  });
  it('refuses a candlestick without four columns', () => {
    expect(buildOption({ panel: panel({ kind: 'candlestick' }), data: data([['2026-01-01', 1]]), viz: 'candlestick', theme: T, palette: [] }).supported).toBe(false);
  });
  it('writes a text alternative from the data', () => {
    const t = describeChart(panel(), data([['2026-01-01T00:00:00Z', 1], ['2026-01-02T00:00:00Z', 9]]), 'line');
    expect(t).toMatch(/minimum 1 tx, maximum 9 tx/);
  });
});

describe('canvas edits', () => {
  const doc = (panels: CanvasPanel[]): CanvasDocument => ({ id: 'c', workspaceId: 'w', documentRevision: 3, dataRevision: 0, panels, markers: [] });
  const a = panel({ panelId: 'a', layout: { x: 0, y: 0, w: 6, h: 6 } });
  const b = panel({ panelId: 'b', layout: { x: 6, y: 0, w: 6, h: 6 } });
  it('orders by y then x', () => expect(ordered([b, a]).map((p) => p.panelId)).toEqual(['a', 'b']));
  it('swaps reading positions and the inverse restores them', () => {
    const d = doc([a, b]);
    const ops = swapWithNeighbour(d, 'a', 1)!;
    expect(ops).toHaveLength(2);
    const after = previewDoc(d, ops);
    expect(ordered(after).map((p) => p.panelId)).toEqual(['b', 'a']);
    expect(previewDoc({ ...d, panels: after }, inverse(d, ops)).map((p) => p.layout)).toEqual([a.layout, b.layout]);
  });
  it('nudges one row when layouts overlap', () => {
    const c2 = panel({ panelId: 'c2', layout: { x: 0, y: 0, w: 6, h: 6 } });
    const ops = swapWithNeighbour(doc([a, c2]), 'a', 1)!;
    expect(ops).toHaveLength(1);
  });
  it('inverse of a remove re-adds the panel', () => {
    expect(inverse(doc([a]), [{ op: 'removePanel', panelId: 'a' }])).toEqual([{ op: 'addPanel', panel: a }]);
  });
  it('clamps resize and maps 48-column layouts to 12', () => {
    expect(resize(a, 20, 0)![0]).toMatchObject({ layout: { w: 12 } });
    expect(spanOf({ x: 0, y: 0, w: 24, h: 4 })).toBe(6);
  });
});
