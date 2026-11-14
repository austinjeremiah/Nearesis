import {
  AbstentionCard,
  ApprovalCard,
  Badge,
  Button,
  ChartSkeleton,
  CitationChip,
  CompletenessBadge,
  EmptyState,
  ErrorState,
  FreshnessBadge,
  IconButton,
  IconPlus,
  Kbd,
  Meter,
  PanelNotice,
  ProvenanceChip,
  RunTimeline,
  Skeleton,
  StatusDot,
  type PanelState,
  PanelStateBadge,
} from "@nearesis/ui";
import { APPROVAL_PENDING, EVENTS } from "../fixtures/run";

const STATES: PanelState[] = [
  "DRAFT",
  "VALIDATING",
  "QUERYING",
  "READY",
  "STALE",
  "REFRESHING",
  "ERROR",
  "ARCHIVED",
];

export function ComponentsPage() {
  return (
    <main className="lab-page">
      <h1>Components</h1>
      <h2>Buttons</h2>
      <div className="lab-row">
        <Button>Default</Button>
        <Button variant="primary">Primary</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="ghost">Ghost</Button>
        <Button size="sm">Small</Button>
        <Button disabled>Disabled</Button>
        <IconButton label="Add panel">
          <IconPlus />
        </IconButton>
        <Kbd>⌘K</Kbd>
      </div>
      <h2>Panel state</h2>
      <div className="lab-row">
        {STATES.map((s) => (
          <PanelStateBadge key={s} state={s} />
        ))}
      </div>
      <h2>Freshness, completeness and honesty labels</h2>
      <div className="lab-row">
        <FreshnessBadge freshness="fresh" age="2m ago" />
        <FreshnessBadge freshness="late" age="41m ago" />
        <FreshnessBadge freshness="partial" />
        <FreshnessBadge freshness="unavailable" />
        <CompletenessBadge completeness="complete" />
        <CompletenessBadge completeness="partial" />
        <ProvenanceChip sourceLabel="SYNTHETIC" certification="experimental" />
        <ProvenanceChip sourceLabel="RECORDED" certification="certified" />
        <ProvenanceChip sourceLabel="LIVE" certification="certified" onToggle={() => undefined} />
        <Badge tone="info">
          <StatusDot tone="info" pulse /> running
        </Badge>
      </div>
      <h2>Notices</h2>
      <div style={{ maxWidth: 520, display: "grid", gap: 8 }}>
        <PanelNotice tone="warn">Source is late: showing last good data from 2026-11-09T23:59Z.</PanelNotice>
        <PanelNotice tone="bad">QUERY_UNRESOLVED: query result not available.</PanelNotice>
        <PanelNotice tone="honesty">SYNTHETIC fixture data. Not production, not attested.</PanelNotice>
      </div>
      <h2>Meters and skeletons</h2>
      <div className="lab-row">
        <Meter value={12} max={60} label="Tokens" />
        <Meter value={45} max={60} label="Tokens" />
        <Meter value={58} max={60} label="Tokens" />
        <Skeleton width={160} height={12} />
        <div style={{ width: 260, height: 160 }} className="lab-fixed">
          <ChartSkeleton />
        </div>
      </div>
      <h2>Empty and error states</h2>
      <div className="lab-grid">
        <div className="lab-fixed" style={{ minHeight: 200 }}>
          <EmptyState title="No rows for this query window">
            Nothing is plotted: an empty result is not a zero series.
          </EmptyState>
        </div>
        <div className="lab-fixed" style={{ minHeight: 200 }}>
          <ErrorState code="QUERY_FAILED" message="upstream timeout after 8s" onRetry={() => undefined} />
        </div>
      </div>
      <h2>Agent run parts</h2>
      <div className="lab-grid">
        <div className="lab-fixed" style={{ background: "var(--surface)" }}>
          <RunTimeline events={EVENTS.slice(0, 9)} running />
        </div>
        <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <ApprovalCard approval={APPROVAL_PENDING} onDecide={() => undefined} />
          <ApprovalCard
            approval={{ ...APPROVAL_PENDING, approvalId: "9040", status: "superseded" }}
            onDecide={() => undefined}
          />
          <AbstentionCard
            metric="solver.volume_share"
            reason="Solver identity is not attested for 24 to 26 October."
          />
          <div className="lab-row">
            <CitationChip
              citation={{ id: "c", label: "Fill rate by chain", queryHash: "b41d0c7e92aa5f31" }}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
