import { describe, expect, it } from 'vitest';
import { buildProvenanceView, buildQuickChartView, queryMetricName, queryWindow } from '@/lib/panel/provenance';
import type { CanvasPanel, PanelData } from '@/lib/panel/types';

const panel = { panelId: 'p', kind: 'bar', title: 'Daily swaps', layout: { x: 0, y: 0, w: 6, h: 6 }, queryRef: { hash: 'h', semanticVersion: '1.0.0' } } as CanvasPanel;
const hash = (c: string) => c.repeat(64);
const data = (over: Record<string, unknown> = {}) =>
  ({
    kind: 'semantic',
    workspaceId: 'w',
    queryHash: hash('a'),
    state: 'partial',
    chart: { panelId: 'p', queryHash: hash('a'), dataRevision: 1, columns: [{ name: 'd', unit: null }], rows: [['2026-01-01'], ['2026-01-02']], downsampling: { method: 'none', originalPoints: 2 }, freshness: 'fresh', sourceWatermark: '2026-11-14T01:13:07.000Z' },
    shape: null,
    provenance: { queryHash: hash('a'), semanticVersion: '1.0.0', semanticModelHash: 'm', sourceSnapshotId: null, rawManifestHash: null, certification: 'certified', sourceLabel: 'LIVE', resultHash: hash('b'), sources: ['near-explorer'], ast: { time: { from: '2026-05-16T00:00:00Z', to: '2026-11-12T00:00:00Z' }, measures: ['live.oneclick_swap_count'] } },
    gaps: [{ from: '2026-02-01', to: '2026-02-03', reason: 'source outage' }],
    coverage: { state: 'partial', daysRequested: 10, daysWithData: 7, missingDays: ['2026-02-01', '2026-02-02', '2026-02-03'], incompleteDays: [] },
    freshness: { state: 'fresh', sourceWatermark: null, sourceWatermarks: {}, generatedAt: null },
    rollupFreshness: null,
    cost: null,
    nullCount: null,
    partialCount: null,
    caveats: ['A caveat'],
    cannotCompute: null,
    ...over,
  }) as unknown as PanelData;

describe('buildProvenanceView', () => {
  it('reads the stored query, source, window, metric and hashes as returned', () => {
    const v = buildProvenanceView(panel, data());
    expect(JSON.parse(v.queryText!)).toEqual(data().provenance!.ast);
    expect(v.queryLabel).toBe('Semantic query');
    expect(v.sources).toEqual(['near-explorer']);
    expect(v.sourceLabel).toBe('LIVE');
    expect(v.window).toBe('2026-05-16 to 2026-11-12');
    expect(v.metric).toMatchObject({ name: 'live.oneclick_swap_count', version: '1.0.0', certification: 'Certified metric', status: null });
    expect(v.rowCount).toBe(2);
    expect(v.resultHash).toEqual({ full: hash('b'), short: `${hash('b').slice(0, 7)}…${hash('b').slice(-4)}` });
    expect(v.queryHash!.full).toBe(hash('a'));
    expect(v.caveats).toEqual(['A caveat']);
    expect(v.freshness.asOf).toMatch(/2026/);
  });
  it('lists partial coverage with its gaps, missing days as unknown', () => {
    const v = buildProvenanceView(panel, data());
    expect(v.coverage.state).toBe('partial');
    expect(v.coverage.lines).toContain('7 of 10 days have data');
    expect(v.coverage.lines.some((l) => l.startsWith('No coverage record (unknown, not zero): 2026-02-01 to 2026-02-03'))).toBe(true);
    expect(v.coverage.gaps).toEqual(['2026-02-01 to 2026-02-03: source outage']);
  });
  it('an analytics result is never certified and names its call', () => {
    const d = data({ kind: 'analytics', provenance: { ...data().provenance, certification: 'experimental', sourceLabel: 'ANALYTICS', ast: { capability: 'accounts.analyze@1', input: { analysis: 'daily', from: '2026-09-13', to: '2026-11-11' } } } });
    const v = buildProvenanceView(panel, d);
    expect(v.queryLabel).toBe('Analytics call');
    expect(v.metric.name).toBe('accounts.analyze@1 (daily)');
    expect(v.metric.certification).toMatch(/not a certified metric/);
    expect(v.window).toBe('2026-09-13 to 2026-11-11');
  });
  it('missing provenance stays unknown instead of invented', () => {
    const v = buildProvenanceView(panel, data({ provenance: null, chart: null }));
    expect(v.queryText).toBeNull();
    expect(v.queryNote).toMatch(/no stored query/);
    expect(v.resultHash).toBeNull();
    expect(v.rowCount).toBeNull();
    expect(v.sources).toEqual([]);
    expect(v.window).toBeNull();
  });
  it('states how many rows were cut when truncated', () => {
    const d = data({ chart: { ...data().chart, truncation: { truncated: true, reason: 'MAX_ROWS', method: 'truncate', requestedRows: 50000, returnedRows: 2, maxRows: 2 } } });
    expect(buildProvenanceView(panel, d).rowsNote).toBe('of 50,000 before truncation');
  });
});

describe('query helpers and quick answers', () => {
  it('queryWindow and queryMetricName tolerate odd input', () => {
    expect(queryWindow(null)).toBeNull();
    expect(queryWindow({ time: { from: '2026-01-01' } })).toBeNull();
    expect(queryMetricName({ measures: [{ name: 'a' }, 'b'] })).toBe('a, b');
    expect(queryMetricName('x')).toBeNull();
  });
  it('a quick answer chart carries what it has and says it has no query', () => {
    const v = buildQuickChartView({ title: 'T', source: 'near-explorer', window: { from: '2026-01-01', to: '2026-02-01' }, coverage: 'complete', metricVersion: '1.0.0', caveats: [], rows: [], kind: 'line' });
    expect(v.queryText).toBeNull();
    expect(v.queryNote).toMatch(/does not keep its query/);
    expect(v.window).toBe('2026-01-01 to 2026-02-01');
    expect(v.queryHash).toBeNull();
  });
});
