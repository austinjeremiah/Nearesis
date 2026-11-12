/**
 * Wire shapes for the investigation routes. The OpenAPI document types only
 * parts of GET /v1/runs/{id}, tasks and the preview, so the observed shapes are
 * written here (checked against the running API). Move to the generated types
 * when the backend types them.
 */

export type RunStateName =
  | 'REQUESTED'
  | 'PLANNING'
  | 'APPROVAL_NEEDED'
  | 'EXECUTING'
  | 'EVIDENCE_REVIEW'
  | 'CANVAS_PATCH_REVIEW'
  | 'COMPLETE'
  | 'PARTIAL'
  | 'BLOCKED'
  | 'BLOCKED_SOURCE'
  | 'CANCELLED'
  | (string & {});

export type Basis = 'observation' | 'inference';
export type FindingStatus = 'supported' | 'contradicted' | 'mixed' | 'insufficient_data' | 'cannot_compute' | 'unverified';

export type Finding = {
  id: string;
  workspaceId: string;
  runId: string;
  agentRole: string;
  status: FindingStatus;
  statement: string;
  facts: { value: string; unit: string; resultRef: { queryHash: string; semanticVersion: string; rowIds: string[]; column: string } }[];
  limitations: string[];
  createdAt: string;
  kind: 'trend' | 'change' | 'comparison' | 'spike' | 'coverage' | 'other';
  basis: Basis;
  panelIds: string[];
  skepticNotes: string[];
  skepticDegraded: boolean;
};

export type RunTaskRef = {
  taskId: string;
  parentTaskId: string | null;
  role: string;
  depth: number;
  status: string;
  hypothesisId?: string;
  objective: string;
  outputRef: string | null;
};

export type Triple = { tokens: number; toolCalls: number; usd: number };

export type RunDetail = {
  runId: string;
  workspaceId: string;
  workflowId: string;
  state: RunStateName;
  terminal: boolean;
  source: 'fixture' | 'live' | string;
  context: { question: string; snapshotId: string; metricVersionMap: string; preregistrationHash: string } | null;
  version: number;
  failure: unknown;
  result: unknown;
  rootTask: RunTaskRef | null;
  children: RunTaskRef[];
  evidenceLinks: { taskId: string; outputRef: string }[];
  createdAt: string;
  updatedAt: string;
  budget?: { total: Triple; spent: Triple; reserved: Triple };
  findings: Finding[];
  interpretation: { state: 'ready' | 'unavailable' | 'none'; reason: string | null; findingCount: number };
};

export type TaskCost = { usd: number | null; tokens: number | null; toolCalls: number; reservedUsd: number | null; releasedUsd: number | null };

export type RunTaskDetail = {
  taskId: string;
  parentTaskId: string | null;
  role: string;
  depth: number;
  status: string;
  objective: string;
  outputRef: string | null;
  startedAt: string | null;
  endedAt: string | null;
  cost: TaskCost;
  toolCalls: { n: number; tool: string; at: string; callKey?: string }[];
  toolCallAttribution: string;
  rejectedToolCalls: unknown[];
};

export type RunTasks = {
  runId: string;
  workspaceId: string;
  tasks: RunTaskDetail[];
  totals: { chargedUsd: number; toolCalls: number; tasks: number };
};

export type ApprovalRow = {
  approvalId: string;
  actionHash: string;
  status: 'pending' | 'approved' | 'rejected' | string;
  kind: string;
  network: string;
  costLimit: number;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
};
export type RunApprovals = { runId: string; state: RunStateName; approvals: ApprovalRow[] };

export type GlobalApproval = ApprovalRow & { runId: string; workspaceId: string; workspaceObjective: string; runState: RunStateName };
export type GlobalApprovals = { approvals: GlobalApproval[]; truncated?: boolean };

export type Budget = { tokens: number; toolCalls: number; usd: number };

export type QuestionPreview = {
  planKind: 'deterministic_composer' | 'director_model';
  deterministic: boolean;
  modelCalls: number;
  spendUsd: number;
  plan: {
    stages: { task: string; role: string; objective: string; capabilities: string[]; budget: Budget }[][];
    privilegedAction: { kind: string; requiresApproval: boolean; network: string; costLimit: number };
  } | null;
  note: string;
  budget: { requested: Budget; minimum: Budget; meetsMinimum: boolean };
  canStart: boolean;
  blockers: { reasonCode: string; message: string }[];
};

export type RunListItem = { runId: string; questionSummary: string; state: RunStateName; terminal: boolean; startedAt: string; updatedAt: string };
