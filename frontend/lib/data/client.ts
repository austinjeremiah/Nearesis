import type { QueryRef, QueryResultEnvelope, SourceMetadata } from '@/lib/contracts';
import * as F from './fixtures';
import type { Point } from './series';

/**
 * Data adapter.
 *
 * Every screen reads through this module and nothing else imports ./fixtures.
 * When the API lands, these function bodies change and no page does, which is
 * also what makes the backend contract testable: each function here returns a
 * shape declared in lib/contracts.
 *
 * Until then every envelope reports `datasetOrigin: 'fixture'` and
 * `dataMode: 'frozen'`, and the UI renders that stamp. Spec 0: sample data is
 * permitted only behind an unmistakable FIXTURE indicator.
 */

export const IS_FIXTURE_BACKEND = true;

const hash = (s: string) => {
  // Stable, non-cryptographic digest for fixture identifiers. Real hashes come
  // from the server; this only needs to be deterministic and 64 hex chars.
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x.toString(16).padStart(8, '0').repeat(8).slice(0, 64);
};

export function sourceFor(sourceId: string): SourceMetadata {
  const src = F.SOURCES.find((s) => s.id === sourceId);
  const degraded = src?.health === 'degraded' || src?.health === 'unavailable';
  return F.sourceMeta({
    sourceId,
    sourceWatermark: src?.watermark ?? null,
    maturity: degraded ? 'partial' : 'finalized',
    coverage: {
      expected: 180,
      observed: Math.round(180 * (src?.coveragePct ?? 1)),
      unknown: src?.coveragePct ? Math.round(180 * (1 - src.coveragePct)) : 0,
      gaps: sourceId === 'near_bigquery' || sourceId === 'intents_explorer' ? ['2026-10-27/2026-10-29'] : [],
    },
    lastFailedRefresh: src?.error
      ? { at: src.error.firstSeen, reason: src.error.message, code: src.error.code }
      : null,
  });
}

export function queryRefFor(metricIds: string[]): QueryRef {
  return {
    canonicalQueryHash: hash(metricIds.join('|') + F.SNAPSHOT_ID),
    semanticVersion: F.SEMANTIC_VERSION,
    snapshotId: F.SNAPSHOT_ID,
    metricIds,
    grain: 'day',
    timezone: 'UTC',
  };
}

/** The full result envelope for a set of metrics, as a panel would receive it. */
export function resultFor(metricIds: string[]): QueryResultEnvelope {
  const metrics = metricIds.map((id) => F.METRICS.find((m) => m.id === id)).filter(Boolean) as F.Metric[];
  const primary = metrics[0];
  const series = F.SERIES[metricIds[0]] ?? [];
  const unknown = series.filter((p) => p[1] === null).length;

  return {
    resultId: `res_${hash(metricIds.join('|')).slice(0, 10)}`,
    query: queryRefFor(metricIds),
    source: sourceFor(primary?.sourceId ?? 'near_bigquery'),
    columns: [
      { id: 'block_date', role: 'time', unit: 'date', nullable: false },
      ...metrics.map((m) => ({
        id: m.id,
        role: 'measure' as const,
        unit: m.unit,
        nullable: true,
        precision: m.kind === 'price' || m.kind === 'ratio' ? 4 : 0,
        proxyCaveat: m.proxyCaveat,
      })),
    ],
    rowsRef: `/api/results/${hash(metricIds.join('|')).slice(0, 10)}/rows`,
    rowCount: series.length,
    resultHash: hash('result' + metricIds.join('|')),
    partialReasonCodes: unknown > 0 ? ['PARTIAL'] : [],
  };
}

export function seriesFor(metricId: string): Point[] {
  return F.SERIES[metricId] ?? [];
}

export function metric(id: string): F.Metric | undefined {
  return F.METRICS.find((m) => m.id === id);
}

export function metrics(): F.Metric[] {
  return F.METRICS;
}

export function sources(): F.Source[] {
  return F.SOURCES;
}

export function source(id: string): F.Source | undefined {
  return F.SOURCES.find((s) => s.id === id);
}

export function workspaces(): F.Workspace[] {
  return F.WORKSPACES;
}

export function workspace(id: string): F.Workspace | undefined {
  return F.WORKSPACES.find((w) => w.id === id);
}

/** Measure-backed panels plus the synthetic chart pack's panels. */
const ALL_PANELS = (): F.FixturePanel[] => [...F.PANELS, ...F.PACK_PANELS];

export function panels(workspaceId: string): F.FixturePanel[] {
  return ALL_PANELS().filter((p) => p.workspaceId === workspaceId);
}

export function panel(workspaceId: string, panelId: string): F.FixturePanel | undefined {
  return ALL_PANELS().find((p) => p.workspaceId === workspaceId && p.id === panelId);
}

export const FIXTURE_WORKSPACE_ID = F.FIXTURE_WORKSPACE_ID;

export function hypotheses(workspaceId: string): F.Hypothesis[] {
  return F.HYPOTHESES.filter((x) => x.workspaceId === workspaceId);
}

export function experiments(workspaceId: string): F.Experiment[] {
  return F.EXPERIMENTS.filter((x) => x.workspaceId === workspaceId);
}

export function experiment(workspaceId: string, id: string): F.Experiment | undefined {
  return F.EXPERIMENTS.find((x) => x.workspaceId === workspaceId && x.id === id);
}

export function claims(workspaceId: string): F.Claim[] {
  return F.CLAIMS.filter((c) => c.workspaceId === workspaceId);
}

export function claim(workspaceId: string, id: string): F.Claim | undefined {
  return F.CLAIMS.find((c) => c.workspaceId === workspaceId && c.id === id);
}

export function markers(workspaceId: string): F.Marker[] {
  return F.MARKERS.filter((m) => m.workspaceId === workspaceId);
}

export function marker(workspaceId: string, id: string): F.Marker | undefined {
  return F.MARKERS.find((m) => m.workspaceId === workspaceId && m.id === id);
}

export function finding(id: string | null): F.Finding | undefined {
  return id ? F.FINDINGS.find((f) => f.id === id) : undefined;
}

export function monitors(workspaceId: string): F.Monitor[] {
  return F.MONITORS.filter((m) => m.workspaceId === workspaceId);
}

export function monitor(workspaceId: string, id: string): F.Monitor | undefined {
  return F.MONITORS.find((m) => m.workspaceId === workspaceId && m.id === id);
}

export function runs(workspaceId: string): F.Run[] {
  return F.RUNS.filter((r) => r.workspaceId === workspaceId);
}

export function run(workspaceId: string, id: string): F.Run | undefined {
  return F.RUNS.find((r) => r.workspaceId === workspaceId && r.id === id);
}

export function activeRun(workspaceId: string): F.Run | undefined {
  return F.RUNS.find((r) => r.workspaceId === workspaceId && r.state === 'running');
}

export function timeline(workspaceId: string): F.TimelineEvent[] {
  return F.TIMELINE.filter((e) => e.workspaceId === workspaceId);
}

export function approvals(workspaceId: string): F.Approval[] {
  return F.APPROVALS.filter((a) => a.workspaceId === workspaceId);
}

export function notifications(): F.Notification[] {
  return F.NOTIFICATIONS;
}

export function capsules(workspaceId?: string): F.Capsule[] {
  return workspaceId ? F.CAPSULES.filter((c) => c.workspaceId === workspaceId) : F.CAPSULES;
}

export function capsule(hashValue: string): F.Capsule | undefined {
  return F.CAPSULES.find((c) => c.hash === hashValue);
}

export function publications(): F.Publication[] {
  return F.PUBLICATIONS;
}

export function publication(id: string): F.Publication | undefined {
  return F.PUBLICATIONS.find((p) => p.id === id);
}

export function branches(workspaceId: string): F.Branch[] {
  return F.BRANCHES.filter((b) => b.workspaceId === workspaceId);
}

export { F as fixtures };
export const SNAPSHOT_ID = F.SNAPSHOT_ID;
export const SNAPSHOT_AS_OF = F.SNAPSHOT_AS_OF;
export const SEMANTIC_VERSION = F.SEMANTIC_VERSION;
export const SETTLEMENT_BOUNDARY = F.SETTLEMENT_BOUNDARY;
