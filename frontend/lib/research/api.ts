'use client';

import { browserApi } from '@/lib/api/browser';
import { ApiRequestError } from '@/lib/api/errors';
import { qk } from '@/lib/api/keys';
import { newKey } from '@/lib/api/transport';

/**
 * Research-surface client: typed wrappers over the evidence graph, markers, monitors,
 * hypotheses, experiments, claims and thesis routes. Response shapes are the observed
 * wire format (several of these routes are `x-schema-status: untyped` in the OpenAPI),
 * so every optional field is typed as optional rather than assumed.
 */

const ws = (wid: string) => `/v1/workspaces/${encodeURIComponent(wid)}`;
const { get, send } = browserApi;

/* ---------------------------------------------------------------- query keys */
export const rk = {
  graph: (wid: string) => [...qk.graph(wid), 'projection'] as const,
  evidence: (wid: string, nid: string) => [...qk.graph(wid), 'evidence', nid] as const,
  rechecks: (wid: string) => [...qk.graph(wid), 'rechecks'] as const,
  impact: (wid: string, metric: string) => [...qk.graph(wid), 'impact', metric] as const,
  comments: (wid: string, nid: string) => [...qk.graph(wid), 'comments', nid] as const,
  claims: (wid: string) => [...qk.graph(wid), 'claims'] as const,
  claim: (wid: string, cid: string) => [...qk.graph(wid), 'claim', cid] as const,
  marker: (wid: string, mid: string) => [...qk.markers(wid), 'one', mid] as const,
  markerTasks: (wid: string, mid: string) => [...qk.markers(wid), 'tasks', mid] as const,
  markerDelegations: (wid: string, mid: string) => [...qk.markers(wid), 'delegations', mid] as const,
  rules: (wid: string) => [...qk.monitors(wid), 'rules'] as const,
  triggers: (wid: string, ruleId?: string) => [...qk.monitors(wid), 'triggers', ruleId ?? 'all'] as const,
  evaluations: (wid: string, ruleId?: string) => [...qk.monitors(wid), 'evaluations', ruleId ?? 'all'] as const,
  counters: (wid: string) => [...qk.monitors(wid), 'counters'] as const,
  watermarks: (wid: string) => [...qk.monitors(wid), 'watermarks'] as const,
  hypotheses: (wid: string) => ['ws', wid, 'hypotheses'] as const,
  hypothesis: (wid: string, hid: string) => ['ws', wid, 'hypotheses', hid] as const,
  experiments: (wid: string) => ['ws', wid, 'experiments'] as const,
  experiment: (wid: string, eid: string) => ['ws', wid, 'experiments', eid] as const,
  theses: (wid: string) => ['ws', wid, 'thesis'] as const,
  thesis: (wid: string, did: string, v?: number) => ['ws', wid, 'thesis', did, v ?? 'latest'] as const,
};

/* --------------------------------------------------------------------- types */
export type Unknowable<T> = ({ state: 'unknown'; reason: string } | ({ state?: string } & T)) & Record<string, unknown>;

export type GraphNode = {
  id: string;
  type: string;
  label: string;
  position?: { x: number; y: number };
  queryRef?: string;
  data?: Record<string, unknown>;
  support?: 'supported' | 'unsupported' | 'contradicted';
  recheckRequired?: boolean;
  tombstone?: boolean;
  missing?: string[];
  confidenceTier?: string;
  evidenceUnavailable?: boolean;
};
export type GraphEdge = { id: string; source: string; target: string; relation: string; origin: 'stored' | 'derived' };
export type GraphProjection = {
  workspaceId: string;
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: { id: string; reason: string; source: string; target: string; relation: string; missing: string[] }[];
};
export type EvidenceDeref = {
  nodeId: string;
  tombstone: boolean;
  kind: string;
  label: string;
  data: Record<string, unknown>;
  rawObjectHash: string | null;
  [k: string]: unknown;
};
export type RecheckFlag = { nodeId?: string; [k: string]: unknown };
export type ImpactResult = {
  metricId: string;
  currentVersion: string | null;
  roots: unknown[];
  affected: { nodeId?: string; id?: string; kind?: string; type?: string; label?: string; depth?: number; [k: string]: unknown }[];
  cycles: unknown[];
  truncated: boolean;
  [k: string]: unknown;
};
export type ReviewComment = {
  commentId?: string;
  id?: string;
  nodeId: string;
  body: string;
  authorId?: string | null;
  createdBy?: string | null;
  createdAt: string;
  [k: string]: unknown;
};

export type ClaimRow = {
  claimId: string;
  statement: string;
  verdict: string;
  support: string;
  disputed: boolean;
  strength: string;
  estimate: Unknowable<Record<string, unknown>>;
  hypothesisIds: string[];
};
export type ClaimDetail = {
  graphVersion: number;
  claimId: string;
  workspaceId: string;
  statement: string;
  support: string;
  verdict: string;
  disputed: boolean;
  missing: string[];
  evidenceUnavailable: boolean;
  strength: { evidenceTier: string; research: Unknowable<Record<string, unknown>> };
  estimate: Unknowable<Record<string, unknown>>;
  counterexamples: Unknowable<Record<string, unknown>>;
  falsification: Unknowable<Record<string, unknown>>;
  evidence: {
    supporting: { nodeId: string; kind: string; label: string }[];
    contradicting: { nodeId: string; kind: string; label: string }[];
    provenance: Record<string, unknown> | null;
    resultIds: string[];
  };
  hypotheses: { hypothesisId: string; [k: string]: unknown }[];
  research: { experimentId?: string; [k: string]: unknown }[];
};

export type Marker = {
  markerId: string;
  workspaceId: string;
  anchorType: 'time_point' | 'time_range' | 'threshold' | 'source_event';
  anchor: { kind: string; at?: string; start?: string; end?: string; metricId?: string; op?: string; value?: number; sourceId?: string; eventId?: string };
  sourcePanelId: string;
  sourceVersion: number;
  createdBy: string | null;
  question: string | null;
  assignedAgents: string[];
  linkedEvidenceIds: string[];
  monitorRuleId: string | null;
  resolution: string | null;
  timestamp: string;
  status: string;
  version: number;
  selection: {
    queryHash: string;
    semanticVersion: string;
    interval: { start: string; end: string };
    seriesIds: string[];
    axisUnits: Record<string, string | null>;
    sourceWatermark: string | null;
  } | null;
  mode: 'live' | 'replay';
  reasonCode: string | null;
};
export type MarkerTask = {
  taskId: string;
  markerId: string;
  runId: string | null;
  workflowId: string | null;
  status: 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  origin: 'assign' | 'rule';
  mode: 'live' | 'replay';
  agents: string[];
  createdAt: string;
  triggerId: string | null;
  reasonCode: string | null;
  grants: string[];
};
export type Delegation = { delegationId: string; markerId: string; taskId: string | null; userId: string; agents: string[]; grants: string[]; parentDelegationId: string | null; depth: number };

export type Condition =
  | { kind: 'compare'; metricId: string; op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne'; value: number }
  | { kind: 'zscore'; metricId: string; windowDays: number; absoluteGt: number }
  | { kind: 'and' | 'or'; terms: Condition[] }
  | { kind: 'not'; term: Condition };
export type MonitorRule = {
  ruleId: string;
  workspaceId: string;
  name: string;
  markerId: string | null;
  sourceId: string;
  condition: Condition;
  frequency: { minIntervalSeconds: number };
  debounceSeconds: number;
  cooldownSeconds: number;
  action: 'notify' | 'investigate';
  enabled: boolean;
  version: number;
  createdBy: string | null;
  createdAt: string;
  semanticVersion: string | null;
  dataMaturity: 'finalized_only' | 'any';
  maxRunsPerDay: number | null;
};
export type MonitorTrigger = {
  triggerId: string;
  ruleId: string;
  sourceId: string;
  watermark: string;
  mode: 'live' | 'replay';
  outcome: string;
  observed: Record<string, number>;
  notificationId: string | null;
  evaluatedAt: string;
};
export type MonitorEvaluation = {
  evaluationId: string;
  ruleId: string;
  ruleVersion: number;
  sourceId: string;
  watermark: string;
  mode: 'live' | 'replay';
  status: string;
  evaluatedValue: Record<string, unknown>;
  triggerId: string | null;
  taskId: string | null;
  evaluatedAt: string;
};

export type Hypothesis = {
  hypothesisId: string;
  versionId: string;
  workspaceId: string;
  version: number;
  parentVersionId: string | null;
  forkedFromVersionId: string | null;
  proposition: string;
  target: string;
  predictor: string;
  benchmark: string;
  falsification: string;
  status: 'draft' | 'frozen';
  registered: boolean;
  registrationHash: string | null;
  registeredAt: string | null;
  frozenBy: string | null;
  preregistration: { hash: string; verified: boolean; source: string; note: string } | null;
  chainCommitment: 'none';
  createdBy: string;
  createdAt: string;
  experimentCount?: number;
  claimCount?: number;
  [k: string]: unknown;
};
export type HypothesisDetail = Hypothesis & { versions: Hypothesis[]; links: { kind: string; ref: string; [k: string]: unknown }[] };

export type ExperimentModel = { id: string; label: string; mae: number | null; smape: number | null; bias: number | null; n: number };
export type Experiment = {
  experimentId: string;
  studyId: string;
  name: string;
  state: string;
  integrity: 'verified' | 'failed' | string;
  integrityIssues: string[];
  status: string;
  evidenceStrength: string;
  claimScope: string;
  methodVersion: string;
  origins: number;
  horizons: number[];
  loss: string;
  methodValidated: boolean;
  reasonCodes: string[];
  window: { firstOrigin: string; lastOrigin: string; scoredOrigins: number } | null;
  preregistrationHash: string | null;
  preregistrationVerified: boolean;
  models: ExperimentModel[];
  hypothesisIds: string[];
  [k: string]: unknown;
};

export type ThesisCheck = { id: string; severity: 'blocking' | 'warning' | 'info'; passed: boolean; detail: string };
export type ThesisValidation = { status: string; checks?: ThesisCheck[]; [k: string]: unknown };
export type ThesisDocRow = { documentId: string; title: string; latestVersion: number; status: string; digest: string; createdAt: string };

/* ------------------------------------------------------------------ commands */
/**
 * Workspace commands carry `expectedVersion` (the workspace version). Every command bumps it, so we read the
 * current version just before sending and retry once when somebody else got in between (STALE_VERSION).
 */
export async function runCommand(wid: string, commandType: string, payload: Record<string, unknown>) {
  const attempt = async () => {
    const w = await browserApi.workspace(wid);
    return send<{ commandId: string; workspaceVersion: number; eventSeq: number; resultFingerprint: string }>(
      'POST',
      `${ws(wid)}/commands`,
      { apiVersion: 'v1', commandId: newKey(), commandType, payload, expectedVersion: w.version },
    );
  };
  try {
    return await attempt();
  } catch (e) {
    if (e instanceof ApiRequestError && e.kind === 'stale_version') return attempt();
    throw e;
  }
}

/** Evidence-graph mutations that take `expectedVersion` in the body (history routes). */
async function withVersion<T>(wid: string, call: (expectedVersion: number) => Promise<T>): Promise<T> {
  const go = async () => call((await browserApi.workspace(wid)).version);
  try {
    return await go();
  } catch (e) {
    if (e instanceof ApiRequestError && e.kind === 'stale_version') return go();
    throw e;
  }
}

export const research = {
  // evidence graph
  graph: (wid: string) => get<GraphProjection>(`${ws(wid)}/graph`),
  evidence: (wid: string, nid: string) => get<EvidenceDeref>(`${ws(wid)}/evidence/${encodeURIComponent(nid)}`),
  rechecks: (wid: string) => get<{ flags: RecheckFlag[] }>(`${ws(wid)}/graph/rechecks`),
  resolveRecheck: (wid: string, nodeId: string, note?: string) =>
    withVersion(wid, (expectedVersion) => send('POST', `${ws(wid)}/graph/rechecks/resolve`, { expectedVersion, nodeId, ...(note ? { note } : {}) })),
  impact: (wid: string, metric: string) => get<ImpactResult>(`${ws(wid)}/impact/${encodeURIComponent(metric)}`),
  comments: (wid: string, nodeId: string) => get<{ comments: ReviewComment[] }>(`${ws(wid)}/comments`, { query: { nodeId } }),
  addComment: (wid: string, nodeId: string, body: string) =>
    withVersion(wid, (expectedVersion) => send('POST', `${ws(wid)}/comments`, { expectedVersion, nodeId, body })),
  saveLayout: (wid: string, positions: Record<string, { x: number; y: number }>) =>
    runCommand(wid, 'graph.save_layout', { positions }),
  setClaimTier: (wid: string, nodeId: string, toTier: 'exploratory' | 'out_of_sample', basis: { kind: 'evidence'; nodeIds: string[] } | { kind: 'memory'; summaryId: string }) =>
    withVersion(wid, (expectedVersion) => send('POST', `${ws(wid)}/claims/tier`, { expectedVersion, nodeId, toTier, basis })),
  // claims
  claims: (wid: string) => get<{ workspaceId: string; graphVersion: number; claims: ClaimRow[] }>(`${ws(wid)}/claims`),
  claim: (wid: string, cid: string) => get<ClaimDetail>(`${ws(wid)}/claims/${encodeURIComponent(cid)}`),
  // markers
  markers: (wid: string) => get<{ markers: Marker[] }>(`${ws(wid)}/markers`),
  marker: (wid: string, mid: string) => get<Marker>(`${ws(wid)}/markers/${encodeURIComponent(mid)}`),
  markerTasks: (wid: string, mid: string) => get<{ tasks: MarkerTask[] }>(`${ws(wid)}/markers/${encodeURIComponent(mid)}/tasks`),
  markerDelegations: (wid: string, mid: string) => get<{ delegations: Delegation[] }>(`${ws(wid)}/markers/${encodeURIComponent(mid)}/delegations`),
  createMarker: (wid: string, payload: Record<string, unknown>) => runCommand(wid, 'marker.create', payload),
  transitionMarker: (wid: string, markerId: string, to: string, resolution?: string) =>
    runCommand(wid, 'marker.transition', { markerId, to, ...(resolution ? { resolution } : {}) }),
  assignMarker: (wid: string, markerId: string, agents: string[]) => runCommand(wid, 'marker.assign', { markerId, agents }),
  linkEvidence: (wid: string, markerId: string, evidenceIds: string[]) => runCommand(wid, 'marker.link_evidence', { markerId, evidenceIds }),
  // monitors
  rules: (wid: string) => get<{ rules: MonitorRule[] }>(`${ws(wid)}/monitors`),
  triggers: (wid: string, ruleId?: string) => get<{ triggers: MonitorTrigger[] }>(`${ws(wid)}/monitors/triggers`, { query: { ruleId } }),
  evaluations: (wid: string, ruleId?: string) => get<{ evaluations: MonitorEvaluation[] }>(`${ws(wid)}/monitors/evaluations`, { query: { ruleId } }),
  counters: (wid: string) => get<{ day: string; live: number; replay: number }>(`${ws(wid)}/monitors/counters`),
  watermarks: (wid: string) => get<{ watermarks: { sourceId: string; watermark: string; mode?: string; [k: string]: unknown }[] }>(`${ws(wid)}/monitors/watermarks`),
  createRule: (wid: string, payload: Record<string, unknown>) => runCommand(wid, 'monitor.rule_create', payload),
  updateRule: (wid: string, payload: Record<string, unknown>) => runCommand(wid, 'monitor.rule_update', payload),
  setRuleEnabled: (wid: string, ruleId: string, enabled: boolean) => runCommand(wid, enabled ? 'monitor.rule_enable' : 'monitor.rule_disable', { ruleId }),
  replayRule: (wid: string, ruleId: string, window: { from: string; to: string }) =>
    send<RuleReplay>('POST', `${ws(wid)}/monitors/${encodeURIComponent(ruleId)}/replay`, window),
  // hypotheses
  hypotheses: (wid: string) => get<{ workspaceId: string; hypotheses: Hypothesis[] }>(`${ws(wid)}/hypotheses`),
  hypothesis: (wid: string, hid: string) => get<HypothesisDetail>(`${ws(wid)}/hypotheses/${encodeURIComponent(hid)}`),
  createHypothesis: (wid: string, body: Record<string, unknown>) => send<Hypothesis>('POST', `${ws(wid)}/hypotheses`, body),
  patchHypothesis: (wid: string, hid: string, body: Record<string, unknown>) => send<Hypothesis>('PATCH', `${ws(wid)}/hypotheses/${hid}`, body),
  freezeHypothesis: (wid: string, hid: string, body: Record<string, unknown>) => send<Hypothesis>('POST', `${ws(wid)}/hypotheses/${hid}/freeze`, body),
  amendHypothesis: (wid: string, hid: string, body: Record<string, unknown>) => send<Hypothesis>('POST', `${ws(wid)}/hypotheses/${hid}/amend`, body),
  forkHypothesis: (wid: string, hid: string, body: Record<string, unknown>) => send<Hypothesis>('POST', `${ws(wid)}/hypotheses/${hid}/fork`, body),
  linkHypothesis: (wid: string, hid: string, body: { kind: 'claim' | 'experiment' | 'finding'; ref: string }) => send('POST', `${ws(wid)}/hypotheses/${hid}/links`, body),
  verifyHypothesis: (wid: string, hid: string) =>
    get<{ hypothesisId: string; intact: boolean; checks: { version: number; stored: string | null; recomputed: string; match: boolean }[] }>(`${ws(wid)}/hypotheses/${hid}/verify`),
  // experiments
  experiments: (wid: string) => get<{ workspaceId: string; scope: string; experiments: Experiment[] }>(`${ws(wid)}/experiments`),
  experiment: (wid: string, eid: string) => get<Experiment & Record<string, unknown>>(`${ws(wid)}/experiments/${encodeURIComponent(eid)}`),
  // thesis
  theses: (wid: string) => get<{ workspaceId: string; documents: ThesisDocRow[] }>(`${ws(wid)}/thesis/documents`),
  thesis: (wid: string, did: string, version?: number) =>
    get<{ documentId: string; title: string; version: number; digest: string; status: string; content: Record<string, unknown>; markdown: string; versions: { version: number; digest: string; status: string; createdAt: string }[]; validation?: ThesisValidation; [k: string]: unknown }>(`${ws(wid)}/thesis/documents/${did}`, { query: { version } }),
  createThesis: (wid: string, title: string) => send<{ documentId: string; version: number; digest: string; status: string; validation: ThesisValidation }>('POST', `${ws(wid)}/thesis/documents`, { title }),
  newThesisVersion: (wid: string, did: string) => send<{ documentId: string; version: number; digest: string; status: string; validation: ThesisValidation; changedSincePrevious: boolean }>('POST', `${ws(wid)}/thesis/documents/${did}/versions`, {}),
  validateThesis: (wid: string, did: string) =>
    send<{ documentId: string; version: number; storedDigest: string; currentDigest: string; upToDate: boolean; validation: ThesisValidation }>('POST', `${ws(wid)}/thesis/documents/${did}/validate`, {}),
  eligibility: (wid: string) => browserApi.publicationEligibility(wid),
};

export const exportThesisHref = (wid: string, did: string, format: 'markdown' | 'pdf', version?: number) =>
  `/api/k/workspaces/${wid}/thesis/documents/${did}/export?format=${format}${version ? `&version=${version}` : ''}`;

/** POST /v1/workspaces/:id/monitors/:ruleId/replay: one rule replayed over recorded daily metric values. */
export type RuleReplay = {
  mode: 'replay';
  label: string;
  ruleId: string;
  sourceId: string;
  window: { from: string; to: string; days: number };
  valueSource: string;
  fired: number;
  results: { day: string; watermark: string; values: Record<string, number>; missing: string[]; outcome: string }[];
};
