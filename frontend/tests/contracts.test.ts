import { describe, it, expect } from 'vitest';
import { QueryResultEnvelope, PanelDocument, WorkspaceEvent, ApiError } from '@/lib/contracts';

const hash = 'a'.repeat(64);
const src = {
  sourceId: 'near_bigquery', snapshotId: 'snap_2026_11_09', rawManifestHash: hash,
  sourceWatermark: '2026-11-09T00:00:00Z', retrievedAt: '2026-11-10T04:12:00Z',
  maturity: 'finalized', datasetOrigin: 'fixture', dataMode: 'frozen',
  coverage: { expected: 90, observed: 88, unknown: 2, gaps: ['2026-10-27/2026-10-29'] },
  visibilityNotes: ['Settlement after 2026-10-27 is partly unreconstructable.'],
  lastSuccessfulRefresh: '2026-11-10T04:12:00Z', lastFailedRefresh: null,
};

describe('contracts', () => {
  it('parses a query result envelope', () => {
    const r = QueryResultEnvelope.parse({
      resultId: 'res_1',
      query: { canonicalQueryHash: hash, semanticVersion: 'v4', snapshotId: 'snap_2026_11_09', metricIds: ['intents.daily_volume'], grain: 'day' },
      source: src,
      columns: [{ id: 'block_date', role: 'time', unit: 'date', nullable: false }],
      rowsRef: '/results/res_1/rows', rowCount: 88, resultHash: hash, partialReasonCodes: ['PARTIAL'],
    });
    expect(r.query.timezone).toBe('UTC');
  });

  it('rejects a non-digest hash', () => {
    expect(() => QueryResultEnvelope.parse({ ...{}, resultId: 'x' })).toThrow();
  });

  it('defaults panel revisions and scale', () => {
    const p = PanelDocument.parse({
      panelId: 'p1', state: 'ready', documentRevision: 1, dataRevision: 1,
      layout: { x: 0, y: 0, w: 6, h: 4 }, provenanceRef: 'prov_1',
      viz: { kind: 'line', title: 'Daily volume', encodings: { x: 'block_date', y: 'volume' },
             annotations: { markerIds: [] }, missingnessPolicy: 'break', description: 'Daily volume by UTC day.' },
    });
    expect(p.evidenceRevision).toBe(0);
    expect(p.viz.scale).toBe('linear');
  });

  it('discriminates workspace events', () => {
    const e = WorkspaceEvent.parse({
      type: 'monitor.rule.triggered.v1', eventId: 'e1', seq: 41, workspaceId: 'w1',
      emittedAt: '2026-11-10T04:12:00Z', ruleId: 'r1', markerId: null, replay: true,
      breachedAt: '2026-11-10T04:00:00Z',
    });
    expect(e.type === 'monitor.rule.triggered.v1' && e.replay).toBe(true);
  });

  it('parses an api error', () => {
    const e = ApiError.parse({ category: 'stale_revision', httpStatus: 409, code: 'REVISION_MISMATCH',
      message: 'This canvas changed since you loaded it.', traceId: 't1', retryable: true,
      nextAction: { label: 'Reload canvas' }, currentRevision: 12 });
    expect(e.currentRevision).toBe(12);
  });
});
