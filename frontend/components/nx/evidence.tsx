import type { ReactNode } from 'react';
import type {
  ApprovalState,
  ClaimVerdict,
  DataMode,
  DatasetOrigin,
  EvidenceStrength,
  PanelStatus,
  ReasonCode,
  RunState,
  SourceHealth,
  SourceMaturity,
  SourceMetadata,
} from '@/lib/contracts';
import { coverageRatio, formatAge, formatPercent, formatUtc } from '@/lib/format';

/**
 * Evidence and status primitives.
 *
 * Spec 3.3 is explicit: "Do not maintain separate handcrafted status styles per
 * screen. Status labels come from shared enums and are consistently mapped to
 * icon, text and accessible tooltip." Everything that renders a status in this
 * app goes through this file, so a verdict cannot mean one thing on Overview
 * and something else on the Evidence Graph.
 */

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'accent' | 'ink' | '';

export function Badge({
  tone = '',
  outline,
  children,
  title,
}: {
  tone?: Tone;
  outline?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge ${tone} ${outline ? 'line' : ''}`.trim()} title={title}>
      {children}
    </span>
  );
}

/* -----------------------------------------------------------------------------
   4.1 — data mode and dataset origin

   Two marks, never one. The time axis (when the data is from) and the origin
   axis (what the data actually is) are independent, and merging them is exactly
   how a fixture ends up presented as live.
   -------------------------------------------------------------------------- */

const MODE_TITLE: Record<DataMode, string> = {
  live: 'Live source path. The watermark shows the latest finalized sample, not the current instant.',
  frozen: 'Immutable snapshot pinned for reproduction. Query semantics are unchanged.',
  replay: 'Historical events deliberately re-emitted for simulation. Excluded from live counters.',
};

const ORIGIN_TITLE: Record<DatasetOrigin, string> = {
  live_provider: 'Observed from the provider.',
  recorded: 'Recorded provider responses, replayed verbatim.',
  synthetic: 'Generated data. Not an observation.',
  fixture: 'Fixture data shipped for development and demo. Not an observation.',
};

export function DataModeIndicator({
  mode,
  origin,
  watermark,
}: {
  mode: DataMode;
  origin: DatasetOrigin;
  watermark?: string | null;
}) {
  // The origin mark is only drawn when it is not a real provider observation:
  // a LIVE + live_provider panel needs one badge, not two.
  const showOrigin = origin !== 'live_provider';
  return (
    <span className="row gap1" style={{ display: 'inline-flex' }}>
      <span className="mode" data-mode={mode} title={MODE_TITLE[mode]}>
        {mode}
      </span>
      {showOrigin && (
        <span className="mode" data-origin={origin} title={ORIGIN_TITLE[origin]}>
          {origin === 'live_provider' ? 'live' : origin}
        </span>
      )}
      {watermark !== undefined && (
        <span className="tiny dim mono" title={`Latest finalized sample: ${formatUtc(watermark)}`}>
          {formatAge(watermark ?? null)}
        </span>
      )}
    </span>
  );
}

/* -----------------------------------------------------------------------------
   4.4 — missingness and uncertainty vocabulary
   -------------------------------------------------------------------------- */

const REASON: Record<ReasonCode, { label: string; tone: Tone; help: string }> = {
  PARTIAL: {
    label: 'Partial',
    tone: 'warn',
    help: 'Some contributing observations were unavailable. The total is a lower bound.',
  },
  STALE: {
    label: 'Stale',
    tone: 'warn',
    help: 'The last known data is older than this source is expected to lag.',
  },
  NOT_OBSERVABLE: {
    label: 'Not observable',
    tone: 'info',
    help: 'Unavailable under the source visibility rules. This is a declared blind spot, not a zero.',
  },
  INSUFFICIENT_DATA: {
    label: 'Insufficient data',
    tone: 'info',
    help: 'The statistical requirement for this test was not met.',
  },
  METHOD_NOT_VALIDATED: {
    label: 'Method not validated',
    tone: 'warn',
    help: 'The method lacks sufficient calibration here. Treat the output as descriptive only.',
  },
  BLOCKED_DEPENDENCY: {
    label: 'Blocked dependency',
    tone: 'bad',
    help: 'An external prerequisite is unavailable, so this could not be computed.',
  },
  BLOCKED_SOURCE: {
    label: 'Blocked source',
    tone: 'bad',
    help: 'This study needs fresh data and its source is degraded. Frozen work can continue.',
  },
  REPLAY: {
    label: 'Replay',
    tone: 'warn',
    help: 'Produced by a simulated historical delivery.',
  },
};

export function ReasonCodeChip({ code }: { code: ReasonCode }) {
  const r = REASON[code];
  return (
    <Badge tone={r.tone} title={r.help}>
      {r.label}
    </Badge>
  );
}

export function ReasonCodeList({ codes }: { codes: ReasonCode[] }) {
  if (codes.length === 0) return null;
  return (
    <span className="row gap1 wrap" style={{ display: 'inline-flex' }}>
      {codes.map((c) => (
        <ReasonCodeChip key={c} code={c} />
      ))}
    </span>
  );
}

/* -----------------------------------------------------------------------------
   claim verdict and evidence strength

   Reported as two marks. Spec 0 forbids collapsing statistical significance,
   evidence strength and source coverage into one number, so a "supported" claim
   on weak evidence has to look different from one on strong evidence.
   -------------------------------------------------------------------------- */

const VERDICT: Record<ClaimVerdict, { label: string; tone: Tone; help: string }> = {
  supported: {
    label: 'Supported',
    tone: 'ok',
    help: 'The pre-registered test was met on the locked evaluation.',
  },
  mixed: {
    label: 'Mixed',
    tone: 'warn',
    help: 'Results differ across specifications or segments. Read the robustness matrix.',
  },
  unsupported: {
    label: 'Unsupported',
    tone: 'bad',
    help: 'The pre-registered test was not met. This is a valid published result.',
  },
  insufficient_data: {
    label: 'Insufficient data',
    tone: 'info',
    help: 'Not enough observations to decide. Not the same as unsupported.',
  },
};

export function EvidenceVerdict({
  verdict,
  strength,
}: {
  verdict: ClaimVerdict;
  strength?: EvidenceStrength;
}) {
  const v = VERDICT[verdict];
  return (
    <span className="row gap1" style={{ display: 'inline-flex' }}>
      <Badge tone={v.tone} title={v.help}>
        {v.label}
      </Badge>
      {strength && (
        <Badge outline title="Evidence strength, reported separately from the verdict.">
          {strength} evidence
        </Badge>
      )}
    </span>
  );
}

/**
 * Spec 14: the Research Lab must distinguish an observed difference from a
 * calibrated statistical result. This is the mark that keeps them apart.
 */
export function StatValidity({
  validated,
  note,
}: {
  validated: boolean;
  note?: string;
}) {
  return (
    <Badge
      tone={validated ? 'ok' : 'warn'}
      outline
      title={
        note ??
        (validated
          ? 'Method calibrated for this data shape.'
          : 'Observed model difference. Statistical significance not established.')
      }
    >
      {validated ? 'Method validated' : 'Descriptive only'}
    </Badge>
  );
}

/* -----------------------------------------------------------------------------
   source health, maturity and coverage
   -------------------------------------------------------------------------- */

const HEALTH: Record<SourceHealth, { label: string; tone: Tone }> = {
  healthy: { label: 'Healthy', tone: 'ok' },
  degraded: { label: 'Degraded', tone: 'warn' },
  auth_needed: { label: 'Auth needed', tone: 'bad' },
  backfill: { label: 'Backfill', tone: 'info' },
  unavailable: { label: 'Unavailable', tone: 'bad' },
};

export function SourceHealthChip({ health }: { health: SourceHealth }) {
  const h = HEALTH[health];
  return <Badge tone={h.tone}>{h.label}</Badge>;
}

const MATURITY_HELP: Record<SourceMaturity, string> = {
  finalized: 'Settled. Will not be revised.',
  provisional: 'Subject to revision as later blocks settle.',
  partial: 'Some contributing observations are missing from this window.',
  stale: 'Older than this source is expected to lag.',
};

export function MaturityChip({ maturity }: { maturity: SourceMaturity }) {
  const tone: Tone = maturity === 'finalized' ? 'ok' : maturity === 'stale' ? 'bad' : 'warn';
  return (
    <Badge tone={tone} outline title={MATURITY_HELP[maturity]}>
      {maturity}
    </Badge>
  );
}

/**
 * Coverage. Spec 7.2: a route that was never sampled shows "Not sampled", not
 * 0% availability, because those mean different things to a reader.
 */
export function CoverageChip({ coverage }: { coverage: SourceMetadata['coverage'] }) {
  const ratio = coverageRatio(coverage);
  if (ratio === null) {
    return (
      <Badge outline title="This window expected no observations.">
        Not sampled
      </Badge>
    );
  }
  const tone: Tone = ratio >= 0.99 ? 'ok' : ratio >= 0.9 ? 'warn' : 'bad';
  const gapNote = coverage.gaps.length ? ` Gaps: ${coverage.gaps.join(', ')}.` : '';
  return (
    <Badge
      tone={tone}
      title={`${coverage.observed} of ${coverage.expected} expected observations, ${coverage.unknown} unknown.${gapNote}`}
    >
      {formatPercent(ratio, 0)} coverage
    </Badge>
  );
}

/* -----------------------------------------------------------------------------
   lifecycle chips
   -------------------------------------------------------------------------- */

const PANEL_TONE: Record<PanelStatus, Tone> = {
  draft: '',
  validating: 'info',
  querying: 'info',
  ready: 'ok',
  stale: 'warn',
  refreshing: 'info',
  error: 'bad',
  archived: '',
};

export function PanelStatusChip({ status }: { status: PanelStatus }) {
  return <Badge tone={PANEL_TONE[status]}>{status}</Badge>;
}

const RUN_TONE: Record<RunState, Tone> = {
  planning: 'info',
  awaiting_approval: 'warn',
  queued: '',
  running: 'info',
  partial: 'warn',
  succeeded: 'ok',
  failed: 'bad',
  cancelled: '',
  blocked: 'bad',
};

export function RunStatus({ state }: { state: RunState }) {
  return <Badge tone={RUN_TONE[state]}>{state.replace(/_/g, ' ')}</Badge>;
}

const APPROVAL_TONE: Record<ApprovalState, Tone> = {
  pending: 'warn',
  approved: 'ok',
  rejected: 'bad',
  expired: '',
  superseded: '',
};

export function ApprovalChip({ state }: { state: ApprovalState }) {
  return <Badge tone={APPROVAL_TONE[state]}>{state}</Badge>;
}
