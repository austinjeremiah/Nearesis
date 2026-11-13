import type { PackColumn, Row, VizSpec } from '@/lib/viz/spec';

import F01 from './canvas-pack/F01_daily_activity_line.json';
import F02 from './canvas-pack/F02_indexed_comparison.json';
import F03 from './canvas-pack/F03_contract_ranked_bar.json';
import F04 from './canvas-pack/F04_stacked_area_disjoint.json';
import F05 from './canvas-pack/F05_synthetic_ohlc_candlestick.json';
import F06 from './canvas-pack/F06_lag_correlation_heatmap.json';
import F07 from './canvas-pack/F07_forecast_band_uncalibrated.json';
import F08 from './canvas-pack/F08_model_error_comparison.json';
import F09 from './canvas-pack/F09_scatter_paired.json';
import F10 from './canvas-pack/F10_retention_cohort.json';
import F11 from './canvas-pack/F11_quote_availability_matrix.json';
import F12 from './canvas-pack/F12_quote_latency_distribution.json';
import F13 from './canvas-pack/F13_economics_waterfall.json';
import F14 from './canvas-pack/F14_source_coverage_calendar.json';
import F15 from './canvas-pack/F15_precision_and_unknown_table.json';
import F16 from './canvas-pack/F16_evidence_graph.json';
import F17 from './canvas-pack/F17_agent_timeline.json';
import F18 from './canvas-pack/F18_empty_series.json';
import F19 from './canvas-pack/F19_partial_coverage.json';
import F20 from './canvas-pack/F20_log_scale_invalid.json';
import F21 from './canvas-pack/F21_large_365_day_daily.json';
import F23 from './canvas-pack/F23_synthetic_swap_statuses.json';
import F24 from './canvas-pack/F24_daily_gas_and_fees.json';
import F25 from './canvas-pack/F25_settlement_duration.json';
import F26 from './canvas-pack/F26_dry_quote_samples.json';

/**
 * The backend team's synthetic chart fixture pack, loaded as data.
 *
 * Every record is `nearesis.canvas.fixture@1`: a chart spec plus the full query
 * result envelope the chart is drawn from, with real deterministic hashes. The
 * point of building against it is that the shape here is the shape the API will
 * return, so swapping the adapter is the only change when the backend lands.
 *
 * NON-NEGOTIABLE, from the pack's own documentation: these are fabricated
 * records for UI testing. They are not NEAR, NEAR Intents, 1Click or provider
 * observations, and every surface that draws them carries the synthetic label.
 */

export const SYNTHETIC_LABEL = 'SYNTHETIC FIXTURE — NOT LIVE NEAR DATA';

export type PackSource = {
  sourceId: string;
  snapshotId: string;
  rawManifestHash: string;
  sourceWatermark: string;
  retrievedAt: string;
  maturity: 'finalized' | 'provisional' | 'partial' | 'stale';
  datasetOrigin: 'live_provider' | 'recorded' | 'synthetic' | 'fixture';
  dataMode: 'live' | 'frozen' | 'replay';
  coverage: { expected: number; observed: number; unknown: number; gaps: string[] };
  visibilityNotes: string[];
};

export type PackResult = {
  resultId: string;
  query: {
    canonicalQueryHash: string;
    semanticVersion: string;
    snapshotId: string;
    metricIds: string[];
  };
  source: PackSource;
  columns: PackColumn[];
  rowsRef: string;
  rowCount: number;
  resultHash: string;
  partialReasonCodes: string[];
  rows: Row[];
};

export type PackFixture = {
  schema: string;
  disclaimer: string;
  fixtureMode: boolean;
  mode: string;
  origin: string;
  snapshotId: string;
  id: string;
  kind: string;
  title: string;
  chartSpec: VizSpec;
  result: PackResult;
  /** Invariants the pack asserts about this record, surfaced in the inspector. */
  expected: Record<string, unknown>;
  interactions: string[];
  ui: { alwaysShow: string };
};

// The JSON modules are typed as their literal shape, which is narrower than the
// contract in places (an empty `markerIds` array, for instance). The cast is at
// the boundary and the shape is asserted by `packSelfTest` below.
const ALL = [
  F01, F02, F03, F04, F05, F06, F07, F08, F09, F10, F11, F12, F13,
  F14, F15, F16, F17, F18, F19, F20, F21, F23, F24, F25, F26,
] as unknown as PackFixture[];

export const PACK: PackFixture[] = ALL;

const BY_ID = new Map(ALL.map((f) => [f.id, f]));
/** Short handles: "F01" resolves to F01_daily_activity_line. */
for (const f of ALL) BY_ID.set(f.id.slice(0, 3), f);

export function packFixture(id: string): PackFixture | undefined {
  return BY_ID.get(id);
}

export function packIds(): string[] {
  return ALL.map((f) => f.id);
}

/**
 * The pack ships `rows` inline, which the real envelope does not: it exposes an
 * authorized `rowsRef` instead. Keeping the read behind a function means the
 * call sites already look like the paginated fetch they will become.
 */
export function packRows(f: PackFixture): Row[] {
  return f.result.rows ?? [];
}

/** Guards the assumptions the loader makes about every record in the pack. */
export function packSelfTest(): string[] {
  const problems: string[] = [];
  for (const f of ALL) {
    if (f.schema !== 'nearesis.canvas.fixture@1') problems.push(`${f.id}: unexpected schema ${f.schema}`);
    if (!f.fixtureMode) problems.push(`${f.id}: fixtureMode is not set`);
    if (f.result.source.datasetOrigin !== 'synthetic') problems.push(`${f.id}: origin is not synthetic`);
    if (f.result.rowCount !== (f.result.rows?.length ?? 0)) {
      problems.push(`${f.id}: rowCount ${f.result.rowCount} does not match ${f.result.rows?.length ?? 0} rows`);
    }
    if (!/^[0-9a-f]{64}$/.test(f.result.resultHash)) problems.push(`${f.id}: result hash is not a sha256 hex string`);
  }
  return problems;
}
