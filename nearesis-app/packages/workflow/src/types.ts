import type { DedupKey } from "./pure.ts";

export const TASK_QUEUE = "nearesis-investigations";

/** Workflow input (brief §4). `tenantId`/`runId` are server-resolved identifiers; `scenario` selects a test fixture only. */
export interface InvestigationInput {
  workspaceId: string;
  investigationId: string;
  questionId: string;
  snapshotRef: string;
  budgetId: string;
  tenantId: string;
  runId: string;
  question?: string;
  /** Semantic layer the run's agents query (contracts 1.4.0 `source`). Absent = fixture. */
  source?: "fixture" | "live";
  scenario?: string;
  /** Delegation grants (marker.assign): when present, every child's leases are narrowed to these capabilities. Absent = role allowlist only. */
  grants?: string[];
  /** Hash of the frozen preregistration every child must carry (ch.16b B12). Absent = the run is unregistered. */
  preregistrationHash?: string;
  /** The human on whose behalf leases are issued and the approved canvas command is applied (server-resolved by the API). */
  requestedBy?: { userId: string; role: "owner" | "admin" | "analyst" | "viewer" };
}

export interface BudgetAmount {
  tokens: number;
  toolCalls: number;
  usd: number;
}

export interface ChildSpec {
  task: string;
  role: string;
  objective: string;
  capabilities: string[];
  inputSnapshot: string;
  budget: BudgetAmount;
  maxChildDepth: number;
  /** The run's dispatch context (four hashes), stamped by the director and verified by `spawnTask` (ch.16b B12). */
  context?: RunContextHashes;
}

/** question, snapshot, metric-version-map and preregistration hashes: identical for every child of a run. */
export interface RunContextHashes {
  question: string;
  snapshotId: string;
  metricVersionMap: string;
  preregistrationHash: string;
}

/** What `bindRunContext` freezes for a run, and what the source gate needs to decide. */
export interface RunContext {
  hashes: RunContextHashes;
  /** metric id -> the data sources behind it (empty when the catalog could not be read). */
  metricSources: Record<string, string[]>;
  /** Why the catalog could not be read (the kernel's reason code, e.g. PLUGIN_LOAD_FAILED); absent when it was read. */
  catalogError?: string;
}

export interface SourceGateView {
  gated: boolean;
  state: "RUN" | "BLOCKED_SOURCE";
  reasonCode: string | null;
  sources: Array<{ source: string; status: string; reason: string | null }>;
}

/** ResearchChildWorkflow input (brief §4) plus server-resolved context. */
export interface ChildInput {
  dedupKey: DedupKey;
  role: string;
  objective: string;
  depth: number;
  parentRunId: string;
  tenantId: string;
  workspaceId: string;
  budgetId: string;
  taskId: string;
  hypothesisId: string;
  /** Inherited from the investigation (see InvestigationInput.grants). */
  grants?: string[];
  /** The run's frozen dispatch context; a child's own children inherit it (ch.16b B12). */
  context?: RunContextHashes;
}

export interface ChildOutcome {
  taskId: string;
  role: string;
  task: string;
  status: "finished" | "failed" | "cancelled" | "rejected";
  reasonCode: string | null;
  /** RoleResult JSON (kept loosely typed so workflow code needs no zod). */
  result: Record<string, unknown> | null;
  deduplicated?: boolean;
}

export interface PlanView {
  stages: ChildSpec[][];
  privilegedAction: {
    kind: string;
    params: Record<string, unknown>;
    network: string;
    costLimit: number;
  } | null;
  requiredMetrics: string[];
  modelVersion: string;
}

export interface PolicyView {
  stageTimeboxMs: number;
  heartbeatTimeoutMs: number;
  approvalTimeoutMs: number;
}

export interface RunFailureView {
  reasonCode: string;
  retryability: "retryable" | "not_retryable" | "human_action_needed";
  humanActionNeeded: string | null;
  lastCheckpoint: string | null;
  replayCommand: string;
}

export interface InvestigationResult {
  runId: string;
  state: string;
  failure: RunFailureView | null;
  failedBranches: Array<{ task: string; role: string; reasonCode: string }>;
  childTaskIds: string[];
  spawnCount: number;
  approvalActionHash: string | null;
}
