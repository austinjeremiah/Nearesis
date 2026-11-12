import { browserApi } from '@/lib/api/browser';
import type { RequestOptions } from '@/lib/api/transport';
import type { WorkspaceDetail } from '@/lib/api/types';

/**
 * Wire types for the history, branch, merge, capsule, publication and cost routes.
 * The backend marks most of these responses `x-schema-status: untyped`, so the shapes
 * below are the observed wire format (checked against the running API); the strict
 * request bodies come from the OpenAPI contracts.
 */

export type DataVintage = {
  eventSeq: number;
  capturedAt: string;
  dataRevision: number;
  documentRevision: number;
  workspaceVersion: number;
  semanticPins: Record<string, unknown>;
  sourceSnapshot: { manifestHash?: string; watermark?: Record<string, string> } | null;
};
export type SnapshotRow = {
  id: string;
  workspaceId: string;
  branchId: string;
  label: string;
  contentHash: string;
  createdAt: string;
  createdBy: string | null;
  dataVintage: DataVintage;
};
export type SnapshotView = {
  historical: true;
  snapshotId: string;
  label: string;
  capturedAt: string;
  dataVintage: DataVintage;
  stale: boolean;
  currentDocumentRevision: number;
  contentHash: string;
  integrityOk: boolean;
  graph?: { nodes: unknown[]; edges: unknown[]; version: number; unresolved: unknown[] };
  canvas?: { panels: { panelId: string; title?: string; kind?: string }[]; markers: unknown[]; documentRevision: number; dataRevision: number };
};
export type SnapshotCompare = Record<string, unknown>;

export type Reconstruction = {
  workspaceId: string;
  revision: number;
  historical: true;
  eventsApplied: { seq: number; type: string; payloadHash: string }[];
  unreplayableEvents: { seq: number; change: string }[];
  canvas: { documentRevision: number; panels: { panelId: string; title?: string }[]; hash: string };
  graph: { nodes: Record<string, unknown>; edges: Record<string, unknown>; hash: string };
  stateHash: string;
  panels: { panelId: string; dataState: 'pinned' | 'vintage_unavailable'; snapshotId: string | null; data: unknown }[];
  pinnedSnapshotId: string | null;
  unavailableSnapshotIds: string[];
  affectedPanelIds: string[];
  exactReproduction: boolean;
  notice: string;
};

export type Branch = {
  id: string;
  workspaceId: string;
  name: string;
  isMain: boolean;
  description: string | null;
  parentBranchId: string | null;
  baseSnapshotId: string | null;
  baseEventSeq: number;
  status: string;
  overlayRevision: number;
  createdAt: string;
  createdBy: string | null;
};
export type ObjectChange = { objectId: string; change: 'added' | 'removed' | 'changed' | string; before?: unknown; after?: unknown };
export type BranchDiff = { branchId: string; against: string; changes: ObjectChange[] };
export type BranchMemoryItem = Record<string, unknown>;

export type ProposalRow = {
  id: string;
  sourceBranchId: string;
  targetBranchId: string;
  status: string;
  conflictCount: number;
  changeCount: number;
  createdAt: string;
  decidedAt: string | null;
};
export type MergeConflict = { objectId: string; resolution: 'unresolved' | 'ours' | 'theirs' | 'keep_both' | string; ours?: unknown; theirs?: unknown; base?: unknown; [k: string]: unknown };
export type Proposal = {
  id: string;
  workspaceId: string;
  sourceBranchId: string;
  targetBranchId: string;
  baseSnapshotId: string | null;
  status: string;
  changes: ObjectChange[];
  conflicts: MergeConflict[];
  evidenceHashDiffs: unknown;
  upstreamRevisions: unknown;
  requiredApprovals: unknown;
  excluded: unknown;
  createdAt: string;
  decidedAt: string | null;
};
export type ReviewComment = { id?: string; nodeId?: string; authorId?: string; body: string; createdAt?: string; [k: string]: unknown };

export type CapsuleListItem = { capsuleId: string; title: string; label: string; createdAt: string | null };
export type PublicationRow = {
  capsuleId: string;
  title: string;
  label: string;
  createdAt: string | null;
  workspaceId: string;
  state: 'published' | 'unpublished' | 'never_published';
  public: boolean;
  badge: string | null;
  publishedAt: string | null;
  acknowledged: string[];
};
export type VerificationEntry = { status: string; method: string; checkedAt: string | null; detail: string; jobId?: string | null; [k: string]: unknown };
export type CapsuleView = {
  capsuleId: string;
  title: string;
  sourceLabel: string;
  createdAt: string | null;
  claims: { id: string; text: string; claimClass: string; resultIds: string[] }[];
  results: { id: string; label: string; value: string; unit: string; computation: string }[];
  hashes: Record<string, string | null>;
  verification: { local: VerificationEntry; outlayer: VerificationEntry; failures: unknown[] };
  rebuild: { command: string; snapshotId: string; steps: string[] };
  exports: { label: string; href: string; sha256: string }[];
  limitations: string[];
  provenance: { id: string; kind: string; label: string; hash: string | null; parents: string[] }[];
  [k: string]: unknown;
};
export type CapsuleResponse = { status: 'available'; capsule: CapsuleView } | { status: 'unavailable'; reason: string };
export type VerifyReport = {
  scope: 'local';
  status: string;
  reportStatus: string;
  failures: unknown[];
  checks: string[];
  notes: string[];
  checkedAt: string;
  hashChain: Record<string, string | null>;
  attestation: { present: boolean; [k: string]: unknown };
};
export type PublicationRecord = {
  capsuleId: string;
  public: boolean;
  record: { state: string; at: string; actorId?: string; acknowledged: string[]; badge: string } | null;
};
export type PublishResult = { capsuleId: string; state: 'published'; badge: { label: string; [k: string]: unknown } };
export type BundleResult = {
  capsuleId: string;
  version: string;
  capsuleHash: string;
  manifestHash: string;
  bundleHash: string;
  label: string;
  /** The API's own re-verification of the signed manifest: 'valid' or a refusal reason. The key id is not returned. */
  signature: string | null;
  signingSource: string;
  hardened: boolean;
  anchor: { log: string; chain: string; seq?: number; anchoredAt?: string; network?: string; txHash?: string };
  manifestFile: string;
};

export type CostDimension = { dimension: string; unit: string; quantity: number | null; usd: number | null; limit: number | null; limitFraction: number | null };
export type CostForecast = {
  label: string;
  method: string;
  basis?: { elapsedHours: number; spentUsd: number; entries: number };
  projectedPeriodUsd: number | null;
  projectedOverCap: boolean | null;
  projectedExhaustionAt: string | null;
  confidence: string;
  assumptions: string[];
};
export type CostBurn = {
  workspaceId: string;
  period: { start: string; end: string };
  policy: unknown;
  spentUsd: number;
  reservedUsd: number;
  capUsd: number | null;
  burnFraction: number | null;
  burnRateUsdPerHour: { last1h: number; last24h: number };
  hardStopped: boolean;
  hardStopReason: string | null;
  dimensions: CostDimension[];
  forecast: CostForecast;
  blocks: { total: number; byReason: Record<string, number> };
  alerts: { sent: number; suppressed: number };
  priceUnknown: { entries: number; byDimension: Record<string, number> };
  asOf: string;
};
export type LedgerEntry = { key: string; dimension: string; quantity: number; usd: number | null; priceUnknown: boolean; state: string; paidOp: string | null; createdAt: string };
export type LedgerBlock = { key: string | null; dimension: string; reason: string; requestedUsd: number | null; ledgerUsd: number; createdAt: string };
export type CostLedger = { entries: LedgerEntry[]; blocks: LedgerBlock[] };
export type CostReconciliation = {
  scope: string;
  period: { start: string; end: string };
  dimensions: {
    dimension: string;
    reserved: { entries: number; usd: number };
    settled: { entries: number; usd: number };
    released: { entries: number };
    priceUnknown: { entries: number };
    estimateVsActual: { estimatedUsd: number; actualUsd: number; varianceUsd: number; comparedEntries: number };
  }[];
  [k: string]: unknown;
};
export type GlobalCost = {
  scope: 'global';
  currency: string;
  ceilingUsd: number;
  hardMaxUsd: number;
  settledUsd: number;
  reservedUsd: number;
  externalUsd: number;
  committedUsd: number;
  remainingUsd: number;
  fraction: number;
  state: string;
  unknownPriceEntries: number;
  thresholds: { fraction: number; usd: number; reached: boolean }[];
  forecast?: CostForecast;
  [k: string]: unknown;
};
export type Collaborator = { userId: string; displayName: string | null; role: string; you: boolean };
export type CollaboratorList = { workspaceId: string; scope: string; collaborators: Collaborator[]; pendingInvites: unknown[] };

const ws = (wid: string) => `/v1/workspaces/${encodeURIComponent(wid)}`;
const cap = (id: string) => `/v1/capsules/${encodeURIComponent(id)}`;
const g = <T>(path: string, o?: RequestOptions) => browserApi.get<T>(path, o);
const s = <T>(m: 'POST' | 'PUT', path: string, body?: unknown, o?: RequestOptions) => browserApi.send<T>(m, path, body, o);

/** Current workspace version, read fresh so a mutation never reuses a stale `expectedVersion`. */
export const currentVersion = async (wid: string) => (await g<WorkspaceDetail>(ws(wid))).version;

export const hist = {
  snapshots: (wid: string) => g<{ snapshots: SnapshotRow[] }>(`${ws(wid)}/snapshots`),
  snapshot: (wid: string, sid: string) => g<SnapshotView>(`${ws(wid)}/snapshots/${sid}`),
  compare: (wid: string, a: string, b: string) => g<SnapshotCompare>(`${ws(wid)}/snapshots/compare`, { query: { a, b } }),
  revision: (wid: string, rev: number) => g<Reconstruction>(`${ws(wid)}/revisions/${rev}`),
  createSnapshot: async (wid: string, label: string) =>
    s<{ result: { snapshotId: string; contentHash: string } }>('POST', `${ws(wid)}/snapshots`, { expectedVersion: await currentVersion(wid), label }),
  branches: (wid: string) => g<{ branches: Branch[] }>(`${ws(wid)}/branches`),
  branch: (wid: string, bid: string) => g<Record<string, unknown>>(`${ws(wid)}/branches/${bid}`),
  diff: (wid: string, bid: string, against?: string) => g<BranchDiff>(`${ws(wid)}/branches/${bid}/diff`, { query: { against } }),
  memory: (wid: string, bid: string) => g<{ items: BranchMemoryItem[] }>(`${ws(wid)}/branches/${bid}/memory`),
  createBranch: async (wid: string, body: { name: string; fromSnapshotId: string; description?: string }) =>
    s<{ result: { branchId: string } }>('POST', `${ws(wid)}/branches`, { expectedVersion: await currentVersion(wid), ...body }),
  addNode: async (wid: string, bid: string, node: { kind: string; label: string }) =>
    s<{ result: { overlayRevision: number } }>('POST', `${ws(wid)}/branches/${bid}/changes`, {
      expectedVersion: await currentVersion(wid),
      ops: [{ op: 'set', objectId: `node:${crypto.randomUUID()}`, value: node }],
    }),
  proposals: (wid: string) => g<{ proposals: ProposalRow[] }>(`${ws(wid)}/merge-proposals`),
  proposal: (wid: string, pid: string) => g<Proposal>(`${ws(wid)}/merge-proposals/${pid}`),
  propose: async (wid: string, sourceBranchId: string) =>
    s<{ result: { proposalId: string; conflictCount: number; changeCount: number } }>('POST', `${ws(wid)}/merge-proposals`, {
      expectedVersion: await currentVersion(wid),
      sourceBranchId,
    }),
  resolve: async (wid: string, pid: string, objectId: string, resolution: 'ours' | 'theirs' | 'keep_both') =>
    s('POST', `${ws(wid)}/merge-proposals/${pid}/resolve`, { expectedVersion: await currentVersion(wid), objectId, resolution }),
  decide: async (wid: string, pid: string, how: 'accept' | 'reject', acknowledgeVerdictChange = false) =>
    s('POST', `${ws(wid)}/merge-proposals/${pid}/${how}`, { expectedVersion: await currentVersion(wid), acknowledgeVerdictChange }),
  comments: (wid: string, nodeId?: string) => g<{ comments: ReviewComment[] }>(`${ws(wid)}/comments`, { query: { nodeId } }),
  addComment: async (wid: string, nodeId: string, body: string) =>
    s('POST', `${ws(wid)}/comments`, { expectedVersion: await currentVersion(wid), nodeId, body }),
};

export const caps = {
  list: () => g<{ capsules: CapsuleListItem[] }>('/v1/capsules'),
  publications: () => g<{ publications: PublicationRow[] }>('/v1/publications'),
  view: (id: string) => g<CapsuleResponse>(cap(id)),
  verify: (id: string) => g<VerifyReport>(`${cap(id)}/verify`),
  publication: (id: string) => g<PublicationRecord>(`${cap(id)}/publication`),
  publish: (id: string, acknowledge: string[]) => s<PublishResult>('POST', `${cap(id)}/publish`, { acknowledge }),
  unpublish: (id: string) => s<{ capsuleId: string; state: 'unpublished' }>('POST', `${cap(id)}/unpublish`, {}),
  bundle: (capsuleId: string, acknowledge: string[]) => s<BundleResult>('POST', '/v1/publish', { capsuleId, acknowledge }),
  publishCheck: (wid: string, metrics: { metricKey: string; version?: number }[]) =>
    s<{ ok?: boolean; [k: string]: unknown }>('POST', `${ws(wid)}/metrics/publish-check`, { metrics }),
};

export const cost = {
  burn: (wid: string) => g<CostBurn>(`${ws(wid)}/cost/burn`),
  ledger: (wid: string) => g<CostLedger>(`${ws(wid)}/cost/ledger`),
  reconciliation: (wid: string) => g<CostReconciliation>(`${ws(wid)}/cost/reconciliation`),
  global: () => g<GlobalCost>('/v1/cost/global'),
  globalReconciliation: () => g<Record<string, unknown>>('/v1/cost/global/reconciliation'),
  setPolicy: (wid: string, body: unknown) => s('PUT', `${ws(wid)}/cost/policy`, body),
  resume: (wid: string) => s('POST', `${ws(wid)}/cost/resume`, {}),
};

export const collab = {
  collaborators: (wid: string) => g<CollaboratorList>(`${ws(wid)}/collaborators`),
  presence: (wid: string, scope: 'layout' | 'notes') =>
    g<{ peers?: unknown[]; [k: string]: unknown }>(`${ws(wid)}/collab/${scope}/presence`),
};

export type MetricRow = { metricKey: string; source: string; status: string; version: number; displayName?: string; unit?: string; exploratory?: boolean; authoredIn?: string[] };
export const metricsApi = { list: () => g<{ metrics: MetricRow[] }>('/v1/metrics') };
