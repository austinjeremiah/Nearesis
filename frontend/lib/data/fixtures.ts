import type {
  AgentRole,
  ApprovalState,
  ClaimVerdict,
  DatasetOrigin,
  EvidenceStrength,
  PanelStatus,
  ReasonCode,
  RunState,
  SourceHealth,
  SourceMaturity,
  SourceMetadata,
  ThesisStatus,
} from '@/lib/contracts';
import { dailySeries, type Point } from './series';

/**
 * The frozen fixture snapshot.
 *
 * Spec 0 permits sample data only behind an unmistakable FIXTURE indicator, so
 * every record here is stamped `datasetOrigin: 'fixture'` and `dataMode:
 * 'frozen'`, and the UI renders that stamp wherever the number appears. When the
 * API lands, this module is replaced and nothing else changes: the adapter in
 * ./client.ts is the only consumer.
 *
 * The data is shaped to exercise the states the spec cares about rather than to
 * look tidy: real gaps, a regime change at the 27 October 2026 settlement
 * boundary, a degraded source, a mixed verdict and an uncalibrated method.
 */

export const SNAPSHOT_ID = 'snap_2026_11_09';
export const SNAPSHOT_AS_OF = '2026-11-09T00:00:00.000Z';
export const RETRIEVED_AT = '2026-11-10T04:12:00.000Z';
export const SEMANTIC_VERSION = 'v4.2.0';

/** Spec 4.3: the date public settlement stopped being fully reconstructable. */
export const SETTLEMENT_BOUNDARY = '2026-10-27';

const h = (s: string) => s.padEnd(64, '0').slice(0, 64);

export function sourceMeta(over: Partial<SourceMetadata> = {}): SourceMetadata {
  return {
    sourceId: 'near_bigquery',
    snapshotId: SNAPSHOT_ID,
    rawManifestHash: h('9f2c41ab71e4'),
    sourceWatermark: SNAPSHOT_AS_OF,
    retrievedAt: RETRIEVED_AT,
    maturity: 'finalized' as SourceMaturity,
    datasetOrigin: 'fixture' as DatasetOrigin,
    dataMode: 'frozen',
    coverage: { expected: 180, observed: 177, unknown: 3, gaps: ['2026-10-27/2026-10-29'] },
    visibilityNotes: [
      `After ${SETTLEMENT_BOUNDARY} a growing share of 1Click settlement cannot be reconstructed from public NEAR transaction hashes.`,
    ],
    lastSuccessfulRefresh: RETRIEVED_AT,
    lastFailedRefresh: null,
    ...over,
  };
}

/* -----------------------------------------------------------------------------
   series
   -------------------------------------------------------------------------- */

const GAPS = ['2026-10-27', '2026-10-28', '2026-10-29'];

export const SERIES: Record<string, Point[]> = {
  /** 1Click swap volume, USD. Shifts down after the settlement boundary because
   *  less of it is publicly observable, which is a visibility change, not a
   *  demand change. The panel says so. */
  'intents.daily_volume': dailySeries({
    seed: 11,
    days: 180,
    endIso: SNAPSHOT_AS_OF,
    start: 2_400_000,
    drift: 0.006,
    noise: 0.14,
    weekly: 0.09,
    gaps: GAPS,
    shift: { from: SETTLEMENT_BOUNDARY, factor: 0.72 },
  }),
  /** Successful actions on NEAR, the forecast target. */
  'near.daily_successful_actions': dailySeries({
    seed: 23,
    days: 180,
    endIso: SNAPSHOT_AS_OF,
    start: 1_180_000,
    drift: 0.0032,
    noise: 0.07,
    weekly: 0.11,
    gaps: GAPS,
  }),
  /** Spec 4.3: a signer proxy, not a count of humans. Labelled everywhere. */
  'near.distinct_signer_proxy': dailySeries({
    seed: 37,
    days: 180,
    endIso: SNAPSHOT_AS_OF,
    start: 86_000,
    drift: 0.0024,
    noise: 0.06,
    weekly: 0.08,
    gaps: GAPS,
  }),
  'near.contract_diversity': dailySeries({
    seed: 41,
    days: 180,
    endIso: SNAPSHOT_AS_OF,
    start: 1_240,
    drift: 0.0011,
    noise: 0.04,
    gaps: GAPS,
  }),
  /** NEAR price, USD. The comparator in H1. */
  'near.price_usd': dailySeries({
    seed: 53,
    days: 180,
    endIso: SNAPSHOT_AS_OF,
    start: 3.42,
    drift: -0.0008,
    noise: 0.035,
    integer: false,
  }),
  /** Dry quote availability, 0..1. Hourly cadence collapsed to a daily rate. */
  'quotes.availability': dailySeries({
    seed: 67,
    days: 90,
    endIso: SNAPSHOT_AS_OF,
    start: 0.94,
    drift: -0.0004,
    noise: 0.03,
    integer: false,
  }),
};

/* -----------------------------------------------------------------------------
   metric catalog
   -------------------------------------------------------------------------- */

export type Metric = {
  id: string;
  name: string;
  unit: string;
  kind: 'count' | 'sum' | 'ratio' | 'price';
  grain: 'day' | 'hour';
  sourceId: string;
  version: string;
  lagHours: number;
  certified: boolean;
  visibility: 'public' | 'partial' | 'restricted';
  owner: string;
  definition: string;
  /** Spec 4.3: stated where the measure approximates something else. */
  proxyCaveat?: string;
  denominatorPolicy?: string;
};

export const METRICS: Metric[] = [
  {
    id: 'intents.daily_volume',
    name: '1Click swap volume',
    unit: 'USD',
    kind: 'sum',
    grain: 'day',
    sourceId: 'intents_explorer',
    version: SEMANTIC_VERSION,
    lagHours: 6,
    certified: true,
    visibility: 'partial',
    owner: 'data-maintainer',
    definition:
      'Sum of completed 1Click swap notional by UTC settlement date, converted at the timestamped rate of the settlement hour.',
    proxyCaveat:
      'Provider-scoped. This is 1Click completed swaps, not all NEAR Intents volume.',
    denominatorPolicy: 'Rows with an unknown amount are excluded and counted as unknown, not zero.',
  },
  {
    id: 'near.daily_successful_actions',
    name: 'Successful actions',
    unit: 'actions',
    kind: 'count',
    grain: 'day',
    sourceId: 'near_bigquery',
    version: SEMANTIC_VERSION,
    lagHours: 4,
    certified: true,
    visibility: 'public',
    owner: 'data-maintainer',
    definition:
      'Count of successful action receipts by block_date, excluding receipts generated by the Intents contracts so the predictor cannot enter the target.',
  },
  {
    id: 'near.distinct_signer_proxy',
    name: 'Distinct signer proxy',
    unit: 'accounts',
    kind: 'count',
    grain: 'day',
    sourceId: 'near_bigquery',
    version: SEMANTIC_VERSION,
    lagHours: 4,
    certified: true,
    visibility: 'public',
    owner: 'data-maintainer',
    definition: 'Distinct signing accounts per UTC day.',
    proxyCaveat:
      'An account proxy, not a count of unique humans. One person may hold many accounts and one account may serve many people.',
  },
  {
    id: 'near.contract_diversity',
    name: 'Contract diversity',
    unit: 'contracts',
    kind: 'count',
    grain: 'day',
    sourceId: 'near_bigquery',
    version: SEMANTIC_VERSION,
    lagHours: 4,
    certified: true,
    visibility: 'public',
    owner: 'data-maintainer',
    definition:
      'Distinct receiver contracts with at least ten successful actions, after removing registered infrastructure accounts.',
  },
  {
    id: 'near.price_usd',
    name: 'NEAR price',
    unit: 'USD',
    kind: 'price',
    grain: 'day',
    sourceId: 'price_provider',
    version: SEMANTIC_VERSION,
    lagHours: 1,
    certified: true,
    visibility: 'public',
    owner: 'data-maintainer',
    definition: 'Daily close in USD from the registered rate provider.',
  },
  {
    id: 'quotes.availability',
    name: 'Quote availability',
    unit: 'ratio',
    kind: 'ratio',
    grain: 'hour',
    sourceId: 'oneclick_sampler',
    version: SEMANTIC_VERSION,
    lagHours: 1,
    certified: true,
    visibility: 'public',
    owner: 'data-maintainer',
    definition: 'Share of sampled routes returning a quote, per sampling interval.',
    proxyCaveat: 'Dry quotes. No transaction was executed and this is not realized execution quality.',
    denominatorPolicy: 'Routes with no validated address are Not sampled, not 0% available.',
  },
  {
    id: 'intents.route_fee_bps',
    name: 'Quoted route fee',
    unit: 'bps',
    kind: 'ratio',
    grain: 'hour',
    sourceId: 'oneclick_sampler',
    version: SEMANTIC_VERSION,
    lagHours: 1,
    certified: false,
    visibility: 'public',
    owner: 'workspace-draft',
    definition: 'Implied fee in basis points from a dry quote. Drafted in a workspace, not certified.',
  },
];

/* -----------------------------------------------------------------------------
   sources
   -------------------------------------------------------------------------- */

export type Source = {
  id: string;
  name: string;
  provider: string;
  health: SourceHealth;
  watermark: string | null;
  coveragePct: number | null;
  checkedAt: string;
  rateLimit: string;
  note?: string;
  error?: { code: string; firstSeen: string; message: string };
};

export const SOURCES: Source[] = [
  {
    id: 'near_bigquery',
    name: 'NEAR public dataset',
    provider: 'BigQuery',
    health: 'healthy',
    watermark: SNAPSHOT_AS_OF,
    coveragePct: 0.983,
    checkedAt: RETRIEVED_AT,
    rateLimit: 'Byte ceiling 2 TB/day, 41% used',
  },
  {
    id: 'intents_explorer',
    name: 'Intents Explorer',
    provider: 'NEAR Intents',
    health: 'degraded',
    watermark: '2026-11-08T12:00:00.000Z',
    coveragePct: 0.871,
    checkedAt: RETRIEVED_AT,
    rateLimit: '600 req/h, backfill paused',
    note: 'Backfill cursor and the recurring collector share one provider quota.',
    error: {
      code: 'PARTNER_JWT_EXPIRED',
      firstSeen: '2026-11-08T13:40:00.000Z',
      message: 'Partner token rejected. Backfill paused rather than retried, to avoid a paid retry loop.',
    },
  },
  {
    id: 'oneclick_sampler',
    name: '1Click dry quote sampler',
    provider: '1Click',
    health: 'healthy',
    watermark: '2026-11-09T23:00:00.000Z',
    coveragePct: 0.94,
    checkedAt: RETRIEVED_AT,
    rateLimit: 'Hourly cadence, 36 routes',
    note: 'Dry quotes only. No transaction is ever executed.',
  },
  {
    id: 'price_provider',
    name: 'Rate provider',
    provider: 'Registered price feed',
    health: 'healthy',
    watermark: SNAPSHOT_AS_OF,
    coveragePct: 1,
    checkedAt: RETRIEVED_AT,
    rateLimit: '1000 req/day',
  },
  {
    id: 'contract_registry',
    name: 'Contract registry',
    provider: 'Nearesis registry',
    health: 'backfill',
    watermark: '2026-11-07T00:00:00.000Z',
    coveragePct: null,
    checkedAt: RETRIEVED_AT,
    rateLimit: 'n/a',
    note: 'Asset ids moved from HOT NEP-245 to Omni NEP-141 on 2026-11-09. Both are retained and versioned by effective date.',
  },
];

/* -----------------------------------------------------------------------------
   workspaces
   -------------------------------------------------------------------------- */

export type Workspace = {
  id: string;
  name: string;
  objective: string;
  template: string;
  thesisStatus: ThesisStatus;
  updatedAt: string;
  owner: string;
  collaborators: number;
  branch: string;
  snapshotId: string;
  budgetUsd: number;
  spentUsd: number;
  pinned?: boolean;
  archived?: boolean;
};

export const WORKSPACES: Workspace[] = [
  {
    id: 'intents-durability',
    name: 'Intents economic durability',
    objective: 'Are NEAR Intents flows economically durable, or transient execution volume?',
    template: 'NEAR Investment Thesis',
    thesisStatus: 'under_investigation',
    updatedAt: '2026-11-10T06:40:00.000Z',
    owner: 'you',
    collaborators: 2,
    branch: 'main',
    snapshotId: SNAPSHOT_ID,
    budgetUsd: 40,
    spentUsd: 12.84,
    pinned: true,
  },
  {
    id: 'intents-adoption',
    name: 'Intents adoption signal',
    objective:
      'Does lagged 1Click volume forecast organic NEAR activity better than price returns?',
    template: 'NEAR Investment Thesis',
    thesisStatus: 'review_required',
    updatedAt: '2026-11-09T18:05:00.000Z',
    owner: 'you',
    collaborators: 1,
    branch: 'main',
    snapshotId: SNAPSHOT_ID,
    budgetUsd: 60,
    spentUsd: 44.1,
    pinned: true,
  },
  {
    id: 'app-composition',
    name: 'Application composition',
    objective: 'Is NEAR application activity diverse once infrastructure flows are separated?',
    template: 'NEAR Investment Thesis',
    thesisStatus: 'draft',
    updatedAt: '2026-11-04T09:20:00.000Z',
    owner: 'r.mehta',
    collaborators: 3,
    branch: 'main',
    snapshotId: SNAPSHOT_ID,
    budgetUsd: 25,
    spentUsd: 0,
  },
  {
    id: 'quote-quality',
    name: 'Route execution quality',
    objective: 'How does quoted execution cost vary by route, size and time of day?',
    template: 'NEAR Investment Thesis',
    thesisStatus: 'published',
    updatedAt: '2026-10-22T11:00:00.000Z',
    owner: 'you',
    collaborators: 0,
    branch: 'main',
    snapshotId: 'snap_2026_10_21',
    budgetUsd: 20,
    spentUsd: 18.2,
    archived: true,
  },
];

/* -----------------------------------------------------------------------------
   hypotheses, experiments, claims
   -------------------------------------------------------------------------- */

export type Hypothesis = {
  id: string;
  workspaceId: string;
  proposition: string;
  target: string;
  predictor: string;
  benchmark: string;
  falsification: string;
  version: string;
  registered: boolean;
  registrationHash?: string;
  registeredAt?: string;
  verdict: ClaimVerdict | null;
  strength: EvidenceStrength | null;
  experimentCount: number;
};

export const HYPOTHESES: Hypothesis[] = [
  {
    id: 'h1',
    workspaceId: 'intents-adoption',
    proposition:
      'Adding lagged 1Click swap volume to past usage improves chronological out-of-sample forecasts of organic NEAR activity more than adding price returns.',
    target: 'near.daily_successful_actions',
    predictor: 'intents.daily_volume (lags 1, 3, 7)',
    benchmark: 'Seasonal naive plus own history',
    falsification:
      'Paired forecast-error difference not better than benchmark at the 7-day horizon across at least 15 origins.',
    version: '1.2.0',
    registered: true,
    registrationHash: h('4a71cd0e93bb'),
    registeredAt: '2026-11-02T09:00:00.000Z',
    verdict: 'mixed',
    strength: 'moderate',
    experimentCount: 4,
  },
  {
    id: 'h2',
    workspaceId: 'intents-durability',
    proposition:
      'Rising Intents throughput is accompanied by independently sourced fees and sustained activity, not only transient execution volume.',
    target: 'near.daily_successful_actions',
    predictor: 'intents.daily_volume',
    benchmark: 'Own history',
    falsification: 'No positive association survives removal of the top 5% volume cohort.',
    version: '0.4.0',
    registered: false,
    verdict: null,
    strength: null,
    experimentCount: 1,
  },
  {
    id: 'h5',
    workspaceId: 'intents-durability',
    proposition:
      `After ${SETTLEMENT_BOUNDARY}, an increasing share of 1Click settlement cannot be reconstructed from public NEAR mainnet transaction hashes.`,
    target: 'reconstructable_share',
    predictor: 'settlement date',
    benchmark: 'Pre-boundary reconstructable share',
    falsification: 'Reconstructable share stays within 5 points of the pre-boundary mean.',
    version: '1.0.0',
    registered: true,
    registrationHash: h('be0417f2a5c9'),
    registeredAt: '2026-11-03T15:30:00.000Z',
    verdict: 'supported',
    strength: 'strong',
    experimentCount: 2,
  },
];

export type Experiment = {
  id: string;
  workspaceId: string;
  hypothesisId: string;
  name: string;
  state: RunState;
  origins: number;
  horizon: string;
  loss: string;
  methodValidated: boolean;
  reasonCodes: ReasonCode[];
  models: { id: string; label: string; mae: number | null; smape: number | null; bias: number | null }[];
  startedAt: string;
};

export const EXPERIMENTS: Experiment[] = [
  {
    id: 'x1',
    workspaceId: 'intents-adoption',
    hypothesisId: 'h1',
    name: 'Rolling-origin forecast, 7-day horizon',
    state: 'succeeded',
    origins: 18,
    horizon: '7 day',
    loss: 'sMAPE with zero-handling rule',
    methodValidated: true,
    reasonCodes: [],
    startedAt: '2026-11-08T10:00:00.000Z',
    models: [
      { id: 'a', label: 'A · history + seasonality', mae: 41200, smape: 0.044, bias: -0.004 },
      { id: 'b', label: 'B · + lagged Intents volume', mae: 33800, smape: 0.033, bias: 0.001 },
      { id: 'c', label: 'C · + lagged price returns', mae: 40900, smape: 0.041, bias: -0.006 },
      { id: 'd', label: 'D · both', mae: 34100, smape: 0.034, bias: 0.002 },
    ],
  },
  {
    id: 'x2',
    workspaceId: 'intents-adoption',
    hypothesisId: 'h1',
    name: 'Robustness: top 5% volume cohort removed',
    state: 'succeeded',
    origins: 18,
    horizon: '7 day',
    loss: 'sMAPE with zero-handling rule',
    methodValidated: true,
    reasonCodes: ['PARTIAL'],
    startedAt: '2026-11-09T08:30:00.000Z',
    models: [
      { id: 'a', label: 'A · history + seasonality', mae: 39800, smape: 0.043, bias: -0.003 },
      { id: 'b', label: 'B · + lagged Intents volume', mae: 38100, smape: 0.041, bias: 0.0 },
      { id: 'c', label: 'C · + lagged price returns', mae: 39600, smape: 0.042, bias: -0.005 },
      { id: 'd', label: 'D · both', mae: 38300, smape: 0.041, bias: 0.001 },
    ],
  },
  {
    id: 'x3',
    workspaceId: 'intents-adoption',
    hypothesisId: 'h1',
    name: '14-day horizon',
    state: 'succeeded',
    origins: 9,
    horizon: '14 day',
    loss: 'sMAPE with zero-handling rule',
    // Fewer origins than the pre-declared minimum, so the comparison is reported
    // as descriptive. Spec 14 requires this to be visibly different from a pass.
    methodValidated: false,
    reasonCodes: ['INSUFFICIENT_DATA', 'METHOD_NOT_VALIDATED'],
    startedAt: '2026-11-09T12:00:00.000Z',
    models: [
      { id: 'a', label: 'A · history + seasonality', mae: 58200, smape: 0.062, bias: -0.009 },
      { id: 'b', label: 'B · + lagged Intents volume', mae: 55900, smape: 0.059, bias: -0.004 },
      { id: 'c', label: 'C · + lagged price returns', mae: 58000, smape: 0.061, bias: -0.008 },
      { id: 'd', label: 'D · both', mae: null, smape: null, bias: null },
    ],
  },
  {
    id: 'x4',
    workspaceId: 'intents-durability',
    hypothesisId: 'h5',
    name: 'Reconstructable settlement share, before and after boundary',
    state: 'succeeded',
    origins: 1,
    horizon: 'n/a',
    loss: 'Descriptive share',
    methodValidated: true,
    reasonCodes: ['NOT_OBSERVABLE'],
    startedAt: '2026-11-05T09:00:00.000Z',
    models: [],
  },
];

export type Claim = {
  id: string;
  workspaceId: string;
  hypothesisId: string;
  statement: string;
  verdict: ClaimVerdict;
  strength: EvidenceStrength;
  estimate: string;
  counterexample: string;
  falsification: string;
  evidenceResultIds: string[];
  disputed: boolean;
};

export const CLAIMS: Claim[] = [
  {
    id: 'c1',
    workspaceId: 'intents-adoption',
    hypothesisId: 'h1',
    statement:
      'Lagged 1Click volume improves 7-day forecasts of organic NEAR activity over an own-history benchmark.',
    verdict: 'mixed',
    strength: 'moderate',
    estimate: 'sMAPE 0.033 vs 0.044 baseline, 18 origins',
    counterexample:
      'The improvement falls to 0.041 vs 0.043 once the top 5% volume cohort is removed, so most of the gain is concentrated.',
    falsification:
      'If the cohort-adjusted difference is not better than benchmark across 15 origins, this is unsupported.',
    evidenceResultIds: ['res_x1_b', 'res_x2_b'],
    disputed: true,
  },
  {
    id: 'c2',
    workspaceId: 'intents-adoption',
    hypothesisId: 'h1',
    statement: 'Price returns add forecast value over own history.',
    verdict: 'unsupported',
    strength: 'moderate',
    estimate: 'sMAPE 0.041 vs 0.044 baseline, inside the interval',
    counterexample: 'No horizon or segment shows a reliable gain.',
    falsification: 'A consistent gain across horizons would overturn this.',
    evidenceResultIds: ['res_x1_c'],
    disputed: false,
  },
  {
    id: 'c3',
    workspaceId: 'intents-durability',
    hypothesisId: 'h5',
    statement: `Publicly reconstructable settlement share fell after ${SETTLEMENT_BOUNDARY}.`,
    verdict: 'supported',
    strength: 'strong',
    estimate: '94% before, 68% after, over a 14-day window either side',
    counterexample: 'None found in the sampled window.',
    falsification: 'A return to within 5 points of the pre-boundary mean.',
    evidenceResultIds: ['res_x4_a'],
    disputed: false,
  },
  {
    id: 'c4',
    workspaceId: 'intents-adoption',
    hypothesisId: 'h1',
    statement: 'The 14-day horizon shows the same improvement as the 7-day horizon.',
    verdict: 'insufficient_data',
    strength: 'none',
    estimate: 'Only 9 forecast origins. The protocol pre-declared a minimum of 15.',
    counterexample: 'Not applicable: the test did not run to the registered standard.',
    falsification: 'Re-run once 15 origins are available.',
    evidenceResultIds: ['res_x3_b'],
    disputed: false,
  },
];

/* -----------------------------------------------------------------------------
   markers, monitors, runs
   -------------------------------------------------------------------------- */

export type Marker = {
  id: string;
  workspaceId: string;
  panelId: string;
  label: string;
  start: string;
  end: string;
  assignedTo: AgentRole | null;
  findingId: string | null;
  createdAt: string;
  replay?: boolean;
};

export const MARKERS: Marker[] = [
  {
    id: 'm1',
    workspaceId: 'intents-adoption',
    panelId: 'p_volume',
    label: 'Volume step-down at the settlement boundary',
    start: '2026-10-25T00:00:00.000Z',
    end: '2026-11-02T00:00:00.000Z',
    assignedTo: 'skeptic',
    findingId: 'f1',
    createdAt: '2026-11-09T14:10:00.000Z',
  },
  {
    id: 'm2',
    workspaceId: 'intents-adoption',
    panelId: 'p_actions',
    label: 'Signer proxy flat while volume climbs',
    start: '2026-09-12T00:00:00.000Z',
    end: '2026-09-30T00:00:00.000Z',
    assignedTo: 'quant',
    findingId: 'f2',
    createdAt: '2026-11-08T11:02:00.000Z',
  },
  {
    id: 'm3',
    workspaceId: 'intents-durability',
    panelId: 'p_volume',
    label: 'Weekend trough deeper than seasonal norm',
    start: '2026-10-10T00:00:00.000Z',
    end: '2026-10-13T00:00:00.000Z',
    assignedTo: null,
    findingId: null,
    createdAt: '2026-11-07T16:45:00.000Z',
  },
];

export type Finding = {
  id: string;
  markerId: string;
  summary: string;
  verdict: ClaimVerdict;
  by: AgentRole;
  at: string;
  evidenceResultIds: string[];
};

export const FINDINGS: Finding[] = [
  {
    id: 'f1',
    markerId: 'm1',
    summary:
      'The step-down coincides with the settlement visibility change, not a fall in swap demand. Reconstructable share drops from 94% to 68% over the same window, and the sampled quote count is unchanged.',
    verdict: 'supported',
    by: 'skeptic',
    at: '2026-11-09T15:02:00.000Z',
    evidenceResultIds: ['res_x4_a'],
  },
  {
    id: 'f2',
    markerId: 'm2',
    summary:
      'Volume rose 34% while the signer proxy moved 3%. Consistent with larger average size rather than wider participation, but the signer proxy cannot separate one person with many accounts.',
    verdict: 'mixed',
    by: 'quant',
    at: '2026-11-08T12:30:00.000Z',
    evidenceResultIds: ['res_x1_b'],
  },
];

export type Monitor = {
  id: string;
  workspaceId: string;
  name: string;
  markerId: string | null;
  enabled: boolean;
  windowHours: number;
  condition: string;
  lastTriggered: string | null;
  triggerCount: number;
  suppressed: number;
  replayOnly: boolean;
};

export const MONITORS: Monitor[] = [
  {
    id: 'mon1',
    workspaceId: 'intents-adoption',
    name: 'Volume and usage divergence',
    markerId: 'm1',
    enabled: true,
    windowHours: 72,
    condition:
      'Daily volume and successful actions diverge by more than 20% over a 7-day mean, on finalized observations only.',
    lastTriggered: '2026-11-09T04:00:00.000Z',
    triggerCount: 2,
    suppressed: 4,
    replayOnly: false,
  },
  {
    id: 'mon2',
    workspaceId: 'intents-adoption',
    name: 'Quote availability floor',
    markerId: null,
    enabled: false,
    windowHours: 24,
    condition: 'Sampled quote availability falls below 85% for two consecutive intervals.',
    lastTriggered: null,
    triggerCount: 0,
    suppressed: 0,
    replayOnly: false,
  },
  {
    id: 'mon3',
    workspaceId: 'intents-durability',
    name: 'Reconstructable share drift (replay)',
    markerId: null,
    enabled: true,
    windowHours: 72,
    condition: 'Reconstructable settlement share moves more than 5 points week over week.',
    lastTriggered: '2026-11-06T00:00:00.000Z',
    triggerCount: 1,
    suppressed: 0,
    replayOnly: true,
  },
];

export type RunTask = {
  id: string;
  role: AgentRole;
  label: string;
  state: RunState;
  startedAt: string;
  endedAt: string | null;
  costUsd: number;
  artifacts: string[];
  toolCalls: { tool: string; detail: string; resultId?: string }[];
};

export type Run = {
  id: string;
  workspaceId: string;
  question: string;
  state: RunState;
  startedAt: string;
  endedAt: string | null;
  budgetUsd: number;
  spentUsd: number;
  tasks: RunTask[];
};

export const RUNS: Run[] = [
  {
    id: 'run_41',
    workspaceId: 'intents-adoption',
    question: 'Does lagged Intents volume forecast organic NEAR activity better than price?',
    state: 'succeeded',
    startedAt: '2026-11-08T10:00:00.000Z',
    endedAt: '2026-11-08T10:14:00.000Z',
    budgetUsd: 8,
    spentUsd: 5.42,
    tasks: [
      {
        id: 't1',
        role: 'director',
        label: 'Decompose the question',
        state: 'succeeded',
        startedAt: '2026-11-08T10:00:00.000Z',
        endedAt: '2026-11-08T10:01:00.000Z',
        costUsd: 0.31,
        artifacts: ['plan_41'],
        toolCalls: [{ tool: 'semantic.catalog.list', detail: '7 certified measures in scope' }],
      },
      {
        id: 't2',
        role: 'scout',
        label: 'Check source coverage',
        state: 'succeeded',
        startedAt: '2026-11-08T10:01:00.000Z',
        endedAt: '2026-11-08T10:03:00.000Z',
        costUsd: 0.44,
        artifacts: ['coverage_41'],
        toolCalls: [
          { tool: 'source.coverage', detail: 'near_bigquery 98.3%' },
          { tool: 'source.coverage', detail: 'intents_explorer 87.1%, degraded' },
        ],
      },
      {
        id: 't3',
        role: 'quant',
        label: 'Rolling-origin forecast comparison',
        state: 'succeeded',
        startedAt: '2026-11-08T10:03:00.000Z',
        endedAt: '2026-11-08T10:11:00.000Z',
        costUsd: 3.9,
        artifacts: ['x1'],
        toolCalls: [
          { tool: 'semantic.query', detail: 'intents.daily_volume, 180d', resultId: 'res_x1_b' },
          { tool: 'experiment.run', detail: '18 origins, 7-day horizon', resultId: 'res_x1_b' },
        ],
      },
      {
        id: 't4',
        role: 'skeptic',
        label: 'Alternative definitions and counterevidence',
        state: 'succeeded',
        startedAt: '2026-11-08T10:11:00.000Z',
        endedAt: '2026-11-08T10:13:00.000Z',
        costUsd: 0.62,
        artifacts: ['x2'],
        toolCalls: [{ tool: 'experiment.run', detail: 'top 5% cohort removed', resultId: 'res_x2_b' }],
      },
      {
        id: 't5',
        role: 'composer',
        label: 'Propose four panels',
        state: 'succeeded',
        startedAt: '2026-11-08T10:13:00.000Z',
        endedAt: '2026-11-08T10:14:00.000Z',
        costUsd: 0.15,
        artifacts: ['patch_41'],
        toolCalls: [{ tool: 'canvas.patch.preview', detail: '4 add operations' }],
      },
    ],
  },
  {
    id: 'run_42',
    workspaceId: 'intents-adoption',
    question: 'Why did volume step down in late October?',
    state: 'running',
    startedAt: '2026-11-10T06:30:00.000Z',
    endedAt: null,
    budgetUsd: 4,
    spentUsd: 1.18,
    tasks: [
      {
        id: 't1',
        role: 'skeptic',
        label: 'Investigate marker m1',
        state: 'running',
        startedAt: '2026-11-10T06:30:00.000Z',
        endedAt: null,
        costUsd: 1.18,
        artifacts: [],
        toolCalls: [{ tool: 'semantic.query', detail: 'reconstructable share, 28d' }],
      },
    ],
  },
];

/* -----------------------------------------------------------------------------
   panels
   -------------------------------------------------------------------------- */

export type FixturePanel = {
  id: string;
  workspaceId: string;
  title: string;
  metricIds: string[];
  kind: 'line' | 'bar' | 'scatter' | 'heatmap' | 'forecast' | 'distribution' | 'table';
  status: PanelStatus;
  layout: { x: number; y: number; w: number; h: number };
  description: string;
  pinned?: boolean;
  reasonCodes: ReasonCode[];
  error?: string;
};

export const PANELS: FixturePanel[] = [
  {
    id: 'p_volume',
    workspaceId: 'intents-adoption',
    title: '1Click swap volume',
    metricIds: ['intents.daily_volume'],
    kind: 'line',
    status: 'ready',
    layout: { x: 0, y: 0, w: 6, h: 4 },
    description:
      'Daily 1Click swap volume in USD by UTC settlement date. Three days are unavailable and the line breaks rather than interpolating.',
    pinned: true,
    reasonCodes: ['PARTIAL'],
  },
  {
    id: 'p_actions',
    workspaceId: 'intents-adoption',
    title: 'Successful actions and signer proxy',
    metricIds: ['near.daily_successful_actions', 'near.distinct_signer_proxy'],
    kind: 'line',
    status: 'ready',
    layout: { x: 6, y: 0, w: 6, h: 4 },
    description:
      'Daily successful actions against the distinct signer proxy. The signer proxy counts accounts, not people.',
    pinned: true,
    reasonCodes: ['PARTIAL'],
  },
  {
    id: 'p_forecast',
    workspaceId: 'intents-adoption',
    title: 'Forecast error by model',
    metricIds: ['near.daily_successful_actions'],
    kind: 'bar',
    status: 'ready',
    layout: { x: 0, y: 4, w: 6, h: 4 },
    description: 'sMAPE by model across 18 rolling origins at the 7-day horizon. Lower is better.',
    reasonCodes: [],
  },
  {
    id: 'p_quotes',
    workspaceId: 'intents-adoption',
    title: 'Quote availability by route',
    metricIds: ['quotes.availability'],
    kind: 'heatmap',
    status: 'stale',
    layout: { x: 6, y: 4, w: 6, h: 4 },
    description:
      'Share of sampled routes returning a dry quote, by route and hour. These are hypothetical quotes, not executed swaps.',
    reasonCodes: ['STALE'],
  },
  {
    id: 'p_fees',
    workspaceId: 'intents-adoption',
    title: 'Implied route fee',
    metricIds: ['intents.route_fee_bps'],
    kind: 'distribution',
    status: 'error',
    layout: { x: 0, y: 8, w: 6, h: 4 },
    description: 'Implied fee in basis points from dry quotes, by route size bucket.',
    reasonCodes: ['BLOCKED_SOURCE'],
    error: 'Intents Explorer returned PARTNER_JWT_EXPIRED. The last good result is from 2026-11-08.',
  },
  {
    id: 'p_volume_d',
    workspaceId: 'intents-durability',
    title: '1Click swap volume',
    metricIds: ['intents.daily_volume'],
    kind: 'line',
    status: 'ready',
    layout: { x: 0, y: 0, w: 12, h: 4 },
    description: 'Daily 1Click swap volume in USD by UTC settlement date.',
    pinned: true,
    reasonCodes: ['PARTIAL'],
  },
];

/* -----------------------------------------------------------------------------
   timeline, approvals, notifications, capsules, publications
   -------------------------------------------------------------------------- */

export type TimelineEvent = {
  id: string;
  workspaceId: string;
  at: string;
  actor: string;
  actorKind: 'human' | 'agent' | 'system';
  action: string;
  detail: string;
  href?: string;
};

export const TIMELINE: TimelineEvent[] = [
  { id: 'e45', workspaceId: 'intents-adoption', at: '2026-11-10T06:30:00.000Z', actor: 'skeptic', actorKind: 'agent', action: 'Run started', detail: 'Investigating marker m1', href: '/w/intents-adoption/runs/run_42' },
  { id: 'e44', workspaceId: 'intents-adoption', at: '2026-11-09T15:02:00.000Z', actor: 'skeptic', actorKind: 'agent', action: 'Finding attached', detail: 'Volume step-down explained by settlement visibility', href: '/w/intents-adoption/markers/m1' },
  { id: 'e43', workspaceId: 'intents-adoption', at: '2026-11-09T14:10:00.000Z', actor: 'you', actorKind: 'human', action: 'Marker created', detail: '2026-10-25 to 2026-11-02 on 1Click swap volume', href: '/w/intents-adoption/markers/m1' },
  { id: 'e42', workspaceId: 'intents-adoption', at: '2026-11-09T12:00:00.000Z', actor: 'quant', actorKind: 'agent', action: 'Experiment completed', detail: '14-day horizon, 9 origins, method not validated', href: '/w/intents-adoption/experiments/x3' },
  { id: 'e41', workspaceId: 'intents-adoption', at: '2026-11-09T04:00:00.000Z', actor: 'system', actorKind: 'system', action: 'Monitor triggered', detail: 'Volume and usage divergence, 72h window', href: '/w/intents-adoption/monitors/mon1' },
  { id: 'e40', workspaceId: 'intents-adoption', at: '2026-11-08T13:40:00.000Z', actor: 'system', actorKind: 'system', action: 'Source degraded', detail: 'Intents Explorer PARTNER_JWT_EXPIRED, backfill paused', href: '/data/sources/intents_explorer' },
  { id: 'e39', workspaceId: 'intents-adoption', at: '2026-11-08T10:14:00.000Z', actor: 'you', actorKind: 'human', action: 'Canvas patch applied', detail: '4 panels added atomically', href: '/w/intents-adoption/canvas' },
  { id: 'e38', workspaceId: 'intents-adoption', at: '2026-11-02T09:00:00.000Z', actor: 'you', actorKind: 'human', action: 'Preregistration frozen', detail: 'H1 v1.2.0, hash 4a71cd0e…', href: '/w/intents-adoption/hypotheses' },
];

export type Approval = {
  id: string;
  workspaceId: string;
  kind: string;
  state: ApprovalState;
  payloadHash: string;
  issuer: string;
  requested: string;
  network: string | null;
  amountCapUsd: number | null;
  expiresAt: string;
  sideEffects: string[];
};

export const APPROVALS: Approval[] = [
  {
    id: 'a1',
    workspaceId: 'intents-adoption',
    kind: 'Publication: commit thesis hash',
    state: 'pending',
    payloadHash: h('77be31c0da42'),
    issuer: 'publisher',
    requested: 'Write the pre-registration digest to NEAR testnet',
    network: 'NEAR testnet',
    amountCapUsd: 0.02,
    expiresAt: '2026-11-10T07:05:00.000Z',
    sideEffects: ['One testnet transaction', 'Publication version 1.3.0 becomes immutable'],
  },
  {
    id: 'a2',
    workspaceId: 'intents-adoption',
    kind: 'Budget increase',
    state: 'pending',
    payloadHash: h('12fa9043bb71'),
    issuer: 'director',
    requested: 'Raise the per-investigation cap from 8.00 to 20.00 USD',
    network: null,
    amountCapUsd: 20,
    expiresAt: '2026-11-10T08:00:00.000Z',
    sideEffects: ['Subsequent runs in this workspace may spend up to the new cap'],
  },
  {
    id: 'a3',
    workspaceId: 'intents-adoption',
    kind: 'Preregistration freeze',
    state: 'approved',
    payloadHash: h('4a71cd0e93bb'),
    issuer: 'you',
    requested: 'Freeze H1 v1.2.0',
    network: null,
    amountCapUsd: null,
    expiresAt: '2026-11-02T09:05:00.000Z',
    sideEffects: ['Later edits create an amendment rather than mutating the hash'],
  },
];

export type Notification = {
  id: string;
  at: string;
  kind: 'approval' | 'monitor' | 'error' | 'publication';
  title: string;
  body: string;
  href: string;
  read: boolean;
};

export const NOTIFICATIONS: Notification[] = [
  { id: 'n1', at: '2026-11-10T06:31:00.000Z', kind: 'approval', title: 'Approval needed: commit thesis hash', body: 'Expires in 34 minutes. NEAR testnet, cap 0.02 USD.', href: '/w/intents-adoption/approvals', read: false },
  { id: 'n2', at: '2026-11-09T04:00:00.000Z', kind: 'monitor', title: 'Monitor triggered: volume and usage divergence', body: 'Divergence exceeded 20% over the 7-day mean on finalized observations.', href: '/w/intents-adoption/monitors/mon1', read: false },
  { id: 'n3', at: '2026-11-08T13:40:00.000Z', kind: 'error', title: 'Intents Explorer degraded', body: 'PARTNER_JWT_EXPIRED. Backfill paused rather than retried.', href: '/data/sources/intents_explorer', read: true },
  { id: 'n4', at: '2026-10-22T11:00:00.000Z', kind: 'publication', title: 'Route execution quality published', body: 'Version 1.0.0 is live with a verified offline rebuild.', href: '/publications', read: true },
];

export type Capsule = {
  hash: string;
  workspaceId: string;
  version: string;
  createdAt: string;
  sizeMb: number;
  reproducible: boolean;
  inputIntegrity: boolean;
  attestation: 'verified' | 'unavailable' | 'failed';
  snapshotId: string;
  files: { path: string; bytes: number }[];
};

export const CAPSULES: Capsule[] = [
  {
    hash: h('c0ffee1234ab'),
    workspaceId: 'intents-adoption',
    version: '1.2.0',
    createdAt: '2026-11-09T19:00:00.000Z',
    sizeMb: 38.4,
    reproducible: true,
    inputIntegrity: true,
    // Spec 0: a local rebuild is not an attestation. The fixture keeps these
    // apart so the UI cannot quietly present one as the other.
    attestation: 'unavailable',
    snapshotId: SNAPSHOT_ID,
    files: [
      { path: 'THESIS.md', bytes: 28_400 },
      { path: 'PREREGISTRATION.md', bytes: 9_100 },
      { path: 'EXPERIMENTS.md', bytes: 14_800 },
      { path: 'LIMITATIONS.md', bytes: 6_200 },
      { path: 'snapshot-manifest.json', bytes: 41_000 },
      { path: 'sql/intents_daily_volume.sql', bytes: 2_100 },
      { path: 'sql/near_actions.sql', bytes: 2_600 },
      { path: 'dist/index.html', bytes: 880_000 },
    ],
  },
  {
    hash: h('ab77de901122'),
    workspaceId: 'quote-quality',
    version: '1.0.0',
    createdAt: '2026-10-22T10:40:00.000Z',
    sizeMb: 21.1,
    reproducible: true,
    inputIntegrity: true,
    attestation: 'verified',
    snapshotId: 'snap_2026_10_21',
    files: [
      { path: 'THESIS.md', bytes: 19_200 },
      { path: 'snapshot-manifest.json', bytes: 23_500 },
      { path: 'dist/index.html', bytes: 640_000 },
    ],
  },
];

export type Publication = {
  id: string;
  workspaceId: string;
  title: string;
  version: string;
  publishedAt: string;
  snapshotId: string;
  capsuleHash: string;
  verdict: ClaimVerdict;
  strength: EvidenceStrength;
  public: boolean;
};

export const PUBLICATIONS: Publication[] = [
  {
    id: 'pub_quote_quality',
    workspaceId: 'quote-quality',
    title: 'Route execution quality on NEAR Intents',
    version: '1.0.0',
    publishedAt: '2026-10-22T11:00:00.000Z',
    snapshotId: 'snap_2026_10_21',
    capsuleHash: h('ab77de901122'),
    verdict: 'mixed',
    strength: 'moderate',
    public: true,
  },
];

/* -----------------------------------------------------------------------------
   branches
   -------------------------------------------------------------------------- */

export type Branch = {
  id: string;
  workspaceId: string;
  name: string;
  basedOn: string;
  createdAt: string;
  author: string;
  description: string;
  changedPanels: number;
  verdictDelta: string | null;
};

export const BRANCHES: Branch[] = [
  { id: 'main', workspaceId: 'intents-adoption', name: 'main', basedOn: '', createdAt: '2026-11-01T09:00:00.000Z', author: 'you', description: 'Primary line of the investigation.', changedPanels: 0, verdictDelta: null },
  { id: 'b_no_top5', workspaceId: 'intents-adoption', name: 'exclude-top-5pct', basedOn: 'main', createdAt: '2026-11-09T08:00:00.000Z', author: 'you', description: 'Removes the top 5% volume cohort to test concentration.', changedPanels: 3, verdictDelta: 'mixed → unsupported on c1' },
  { id: 'b_stable_only', workspaceId: 'intents-adoption', name: 'stablecoin-routes-only', basedOn: 'main', createdAt: '2026-11-09T16:20:00.000Z', author: 'r.mehta', description: 'Restricts routes to stablecoin pairs.', changedPanels: 2, verdictDelta: 'no change' },
];
