/**
 * View-model types for @nearesis/ui. They mirror the existing HTTP and contract shapes (ChartData, run read, approval
 * list) so apps/web maps its data in with no new endpoints. Nothing here carries code, formatters or HTML.
 */
export type Freshness = "fresh" | "late" | "partial" | "stale" | "unavailable";
export type Completeness = "complete" | "partial" | "unavailable";
export type SourceLabel = "SYNTHETIC" | "RECORDED" | "LIVE";
export type Certification = "certified" | "experimental" | "partial" | "stale";
export type PanelState =
  "DRAFT" | "VALIDATING" | "QUERYING" | "READY" | "STALE" | "REFRESHING" | "ERROR" | "ARCHIVED";
export type RunState =
  | "REQUESTED"
  | "PLANNING"
  | "APPROVAL_NEEDED"
  | "EXECUTING"
  | "EVIDENCE_REVIEW"
  | "CANVAS_PATCH_REVIEW"
  | "COMPLETE"
  | "PARTIAL"
  | "BLOCKED"
  | "CANCELLED";

export const TERMINAL_RUN_STATES: readonly RunState[] = ["COMPLETE", "PARTIAL", "BLOCKED", "CANCELLED"];

export type ConnectionState = "live" | "reconnecting" | "offline" | "reload_required";

/** Declared chart kinds the canvas renders. Anything else is not a chart. */
export type ChartKind = "line" | "area" | "bar" | "scatter" | "heatmap" | "candlestick";

export interface ChartColumn {
  name: string;
  unit: string | null;
}

export interface ChartGap {
  from: string;
  to: string;
  reason: string;
}

export type ChartMarker =
  | { id: string; kind: "time_point"; at: string; label?: string }
  | { id: string; kind: "time_range"; start: string; end: string; label?: string }
  | { id: string; kind: "threshold"; value: number; op: "gt" | "lt"; label?: string };

/**
 * A declared chart. `rows` follow `columns`. Per kind: line/area/bar/scatter use `x` and `y[]`; heatmap uses
 * x (category), y[0] (row category field) and `value` (the measure field); candlestick uses x (time) and
 * y = [open, close, low, high] fields. Fields are resolved by name, never by column position.
 */
export interface ChartSpec {
  kind: ChartKind;
  title: string;
  columns: ChartColumn[];
  rows: Array<Array<string | number | null>>;
  x: { field: string; type: "time" | "category" | "value" };
  y: Array<{ field: string; unit?: string | null; side?: "left" | "right" }>;
  /** Heatmap only: name of the value column. */
  value?: { field: string; unit?: string | null };
  scale?: "linear" | "log" | "index_100";
  gaps?: ChartGap[];
  markers?: ChartMarker[];
  downsampling?: { method: "none" | "min_max_bucket" | "lttb"; originalPoints: number };
}

export interface RunTaskView {
  taskId: string;
  parentTaskId: string | null;
  role: string;
  depth: number;
  status: "QUEUED" | "RUNNING" | "WAITING_APPROVAL" | "DONE" | "FAILED" | "CANCELLED";
  hypothesisId?: string;
  objective: string | null;
  outputRef: string | null;
}

/** GET /v1/runs/:id response (apps/api runs.ts getRun). */
export interface RunView {
  runId: string;
  workspaceId: string;
  state: RunState;
  terminal: boolean;
  version: number;
  failure: {
    reasonCode: string;
    retryability: "retryable" | "not_retryable" | "human_action_needed";
    humanActionNeeded: string | null;
    lastCheckpoint: string | null;
    replayCommand: string;
  } | null;
  result: unknown;
  rootTask: RunTaskView | null;
  children: RunTaskView[];
  evidenceLinks: Array<{ taskId: string; outputRef: string | null }>;
  /** Interpretation stage (contracts 1.8.x): grounded findings about the run's panel results. Absent on older servers. */
  findings?: RunFinding[];
  interpretation?: { state: "ready" | "unavailable" | "none"; reason: string | null; findingCount: number };
}

/** One interpreted finding as GET /v1/runs/:id returns it (contracts `InterpretedFinding`). */
export interface RunFinding {
  id: string;
  statement: string;
  kind: "trend" | "change" | "comparison" | "spike" | "coverage" | "other";
  basis: "observation" | "inference";
  status: "supported" | "contradicted" | "mixed" | "insufficient_data" | "cannot_compute" | "unverified";
  limitations: string[];
  skepticNotes: string[];
  skepticDegraded?: boolean;
  /** Panels whose result rows the finding was computed from. */
  panelIds: string[];
  facts: Array<{
    value: string;
    unit: string;
    resultRef: { queryHash: string; column: string; rowIds: string[] };
  }>;
}

/** GET /v1/runs/:id/approvals entry. `actionHash` is what an approve/reject must echo. */
export interface ApprovalView {
  approvalId: string;
  actionHash: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  kind: string | null;
  network: string | null;
  costLimit: number | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

/** Budget the question was submitted with, plus usage when the API exposes it (see handoff: usage read is a gap). */
export interface BudgetView {
  tokens: { used: number | null; total: number };
  toolCalls: { used: number | null; total: number };
  usd: { used: number | null; total: number };
}

/** One row of the live run log, derived from SSE domain events (run.state_changed, agent.spawned, task.*, query.completed). */
export type TimelineEvent =
  | { id: string; kind: "state"; at: string; state: RunState; note?: string }
  | {
      id: string;
      kind: "agent";
      at: string;
      role: string;
      objective: string | null;
      taskId: string;
      parentTaskId: string | null;
      status: RunTaskView["status"];
    }
  | {
      id: string;
      kind: "query";
      at: string;
      taskId: string | null;
      metric: string;
      queryHash: string;
      rows: number | null;
      certification: Certification;
    }
  | { id: string; kind: "abstention"; at: string; taskId: string | null; metric: string; reason: string }
  | { id: string; kind: "approval"; at: string; approvalId: string }
  | {
      id: string;
      kind: "panel";
      at: string;
      panelId: string;
      title: string;
      queryHash: string;
      added: boolean;
    };

export interface Citation {
  id: string;
  label: string;
  queryHash: string;
  sourceLabel?: SourceLabel;
}

export interface ThreadItem {
  id: string;
  role: "user" | "run";
  text?: string;
  at: string;
  runId?: string;
}
