import { z } from "zod";
import { IsoDateTime, Sha256Hex, Uuid } from "./common.ts";
import { EvidenceRelation } from "./research.ts";

/**
 * Evidence graph and time machine API contracts (ch.10, ch.09 Branching/Playback/Yjs).
 * All mutations are workspace commands: `expectedVersion` is the optimistic-concurrency token, `commandId` the
 * idempotency key (a retry with the same commandId replays and never re-applies).
 */

export const EvidenceNodeKind = z.enum([
  "hypothesis",
  "observation",
  "query",
  "model",
  "source",
  "marker",
  "agent",
  "statistical_result",
  "claim",
  "verification_artifact",
]);
export type EvidenceNodeKind = z.infer<typeof EvidenceNodeKind>;

const CommandMeta = {
  commandId: Uuid.optional(),
  expectedVersion: z.number().int().nonnegative(),
};

export const SemanticPins = z.record(z.string().min(1).max(200), z.string().min(1).max(64));
export type SemanticPins = z.infer<typeof SemanticPins>;

export const AddEvidenceNodeRequest = z.strictObject({
  ...CommandMeta,
  nodeId: Uuid.optional(),
  kind: EvidenceNodeKind,
  label: z.string().min(1).max(500),
  data: z.record(z.string(), z.unknown()).default({}),
  /** metric id -> semantic version this node was computed against (drives impact analysis). */
  semanticPins: SemanticPins.default({}),
});
export type AddEvidenceNodeRequest = z.infer<typeof AddEvidenceNodeRequest>;

export const AddEvidenceEdgeRequest = z.strictObject({
  ...CommandMeta,
  from: Uuid,
  to: Uuid,
  relation: EvidenceRelation,
  reason: z.string().max(1000).optional(),
  /**
   * Explicit tombstone contract: when an endpoint is missing, `tombstoneMissing` creates a visible tombstone node for
   * it (with `tombstoneReason`) instead of rejecting. Never silent.
   */
  tombstoneMissing: z.boolean().default(false),
  tombstoneReason: z.string().min(1).max(500).optional(),
  tombstoneKind: EvidenceNodeKind.default("source"),
});
export type AddEvidenceEdgeRequest = z.infer<typeof AddEvidenceEdgeRequest>;

export const SemanticVersionChangeRequest = z.strictObject({
  ...CommandMeta,
  metricId: z.string().min(1).max(200),
  toVersion: z.string().min(1).max(64),
  /** Revalidation tasks created immediately; the rest of the impacted set is queued with a visible count. */
  revalidationCap: z.number().int().min(0).max(10_000).optional(),
});
export type SemanticVersionChangeRequest = z.infer<typeof SemanticVersionChangeRequest>;

export const ResolveRecheckRequest = z.strictObject({
  ...CommandMeta,
  nodeId: Uuid,
  note: z.string().max(1000).optional(),
});

/** Shallow-merge `data` into a node's data (e.g. completing a claim's provenance tuple). Appends an event. */
export const UpdateNodeDataRequest = z.strictObject({
  ...CommandMeta,
  nodeId: Uuid,
  data: z.record(z.string(), z.unknown()),
  reason: z.string().max(1000).optional(),
});
export type UpdateNodeDataRequest = z.infer<typeof UpdateNodeDataRequest>;

/** Restrict a node (and what depends only on it) to explicit grantees. Owner/admin only. */
export const SetNodeRestrictionRequest = z.strictObject({
  ...CommandMeta,
  nodeId: Uuid,
  restricted: z.boolean(),
  grantUserIds: z.array(Uuid).max(200).default([]),
});
export type SetNodeRestrictionRequest = z.infer<typeof SetNodeRestrictionRequest>;

/** A correction never rewrites history: it appends a compensating event that references the original event. */
export const CorrectNodeRequest = z.strictObject({
  ...CommandMeta,
  nodeId: Uuid,
  /** Sequence number of the journal event being corrected. */
  correctsSeq: z.number().int().positive(),
  label: z.string().min(1).max(500).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().min(1).max(1000),
});
export type CorrectNodeRequest = z.infer<typeof CorrectNodeRequest>;

/** Retention purge of a snapshot payload (identity and content hash stay). Owner/admin only. */
export const PurgeSnapshotRequest = z.strictObject({
  ...CommandMeta,
  snapshotId: Uuid,
  reason: z.string().min(1).max(500),
});
export type PurgeSnapshotRequest = z.infer<typeof PurgeSnapshotRequest>;

export const DataVintage = z.strictObject({
  capturedAt: IsoDateTime,
  workspaceVersion: z.number().int().nonnegative(),
  eventSeq: z.number().int().nonnegative(),
  documentRevision: z.number().int().nonnegative(),
  dataRevision: z.number().int().nonnegative(),
  /** Pinned source snapshot (manifest hash and watermark), when the caller supplies one. */
  sourceSnapshot: z
    .strictObject({
      manifestHash: Sha256Hex.optional(),
      watermark: z.record(z.string(), z.string()).optional(),
    })
    .nullable(),
  semanticPins: SemanticPins,
});
export type DataVintage = z.infer<typeof DataVintage>;

export const CreateSnapshotRequest = z.strictObject({
  ...CommandMeta,
  snapshotId: Uuid.optional(),
  label: z.string().min(1).max(200),
  sourceSnapshot: DataVintage.shape.sourceSnapshot.optional(),
});
export type CreateSnapshotRequest = z.infer<typeof CreateSnapshotRequest>;

export const SnapshotSummary = z.strictObject({
  id: Uuid,
  workspaceId: Uuid,
  branchId: Uuid,
  label: z.string(),
  contentHash: Sha256Hex,
  createdAt: IsoDateTime,
  createdBy: Uuid,
  dataVintage: DataVintage,
});
export type SnapshotSummary = z.infer<typeof SnapshotSummary>;

/** A historical read is always labelled; it is never silently today's data. */
export const HistoricalLabel = z.strictObject({
  historical: z.literal(true),
  snapshotId: Uuid,
  label: z.string(),
  capturedAt: IsoDateTime,
  dataVintage: DataVintage,
  /** True when current data has moved on since the snapshot (current revision differs). */
  stale: z.boolean(),
  currentDocumentRevision: z.number().int().nonnegative(),
});
export type HistoricalLabel = z.infer<typeof HistoricalLabel>;

export const ObjectChange = z.strictObject({
  objectId: z.string().min(1).max(300),
  change: z.enum(["added", "removed", "changed"]),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type ObjectChange = z.infer<typeof ObjectChange>;

export const SnapshotDiff = z.strictObject({
  from: Uuid,
  to: Uuid,
  changes: z.array(ObjectChange),
  documentRevision: z.strictObject({ from: z.number().int(), to: z.number().int() }),
  semanticPinChanges: z.array(
    z.strictObject({ metricId: z.string(), from: z.string().nullable(), to: z.string().nullable() }),
  ),
});
export type SnapshotDiff = z.infer<typeof SnapshotDiff>;

export const CreateBranchRequest = z.strictObject({
  ...CommandMeta,
  branchId: Uuid.optional(),
  fromSnapshotId: Uuid,
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
});
export type CreateBranchRequest = z.infer<typeof CreateBranchRequest>;

/** Overlay operations on a branch. Object ids: `node:<id>`, `panel:<id>`, `metric:<id>`, `edge:<from>|<to>|<rel>`. */
export const BranchOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("set"), objectId: z.string().min(1).max(300), value: z.unknown() }),
  z.strictObject({ op: z.literal("delete"), objectId: z.string().min(1).max(300) }),
]);
export type BranchOp = z.infer<typeof BranchOp>;

export const BranchChangeRequest = z.strictObject({
  ...CommandMeta,
  ops: z.array(BranchOp).min(1).max(200),
});
export type BranchChangeRequest = z.infer<typeof BranchChangeRequest>;

export const BranchSummary = z.strictObject({
  id: Uuid,
  workspaceId: Uuid,
  name: z.string(),
  parentBranchId: Uuid.nullable(),
  baseSnapshotId: Uuid.nullable(),
  baseEventSeq: z.number().int().nonnegative(),
  status: z.enum(["active", "merged", "closed"]),
  overlayRevision: z.number().int().nonnegative(),
  createdAt: IsoDateTime,
  createdBy: Uuid,
});
export type BranchSummary = z.infer<typeof BranchSummary>;

export const ProposeMergeRequest = z.strictObject({
  ...CommandMeta,
  proposalId: Uuid.optional(),
  sourceBranchId: Uuid,
  /** Omit to merge into the workspace's active (main) branch. */
  targetBranchId: Uuid.optional(),
});
export type ProposeMergeRequest = z.infer<typeof ProposeMergeRequest>;

export const MergeConflict = z.strictObject({
  objectId: z.string(),
  base: z.unknown(),
  ours: z.unknown(),
  theirs: z.unknown(),
  resolution: z.enum(["unresolved", "ours", "theirs", "keep_both"]),
});
export type MergeConflict = z.infer<typeof MergeConflict>;

export const MergeProposal = z.strictObject({
  id: Uuid,
  workspaceId: Uuid,
  sourceBranchId: Uuid,
  targetBranchId: Uuid,
  baseSnapshotId: Uuid,
  status: z.enum(["open", "accepted", "rejected"]),
  /** Changes that apply cleanly (no concurrent change on the target). */
  changes: z.array(ObjectChange),
  conflicts: z.array(MergeConflict),
  evidenceHashDiffs: z.array(z.strictObject({ objectId: z.string(), before: Sha256Hex, after: Sha256Hex })),
  upstreamRevisions: z.strictObject({
    targetOverlayRevision: z.number().int(),
    targetEventSeq: z.number().int(),
  }),
  requiredApprovals: z.array(z.string()),
  createdAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
});
export type MergeProposal = z.infer<typeof MergeProposal>;

export const ResolveConflictRequest = z.strictObject({
  ...CommandMeta,
  objectId: z.string().min(1).max(300),
  resolution: z.enum(["ours", "theirs", "keep_both"]),
});
export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequest>;

export const DecideMergeRequest = z.strictObject({
  ...CommandMeta,
  /** Required when the merge changes a claim verdict (certified interpretations need explicit acceptance). */
  acknowledgeVerdictChange: z.boolean().default(false),
});
export type DecideMergeRequest = z.infer<typeof DecideMergeRequest>;

export const TimelineEntry = z.strictObject({
  at: IsoDateTime,
  seq: z.number().int().nonnegative().nullable(),
  kind: z.enum(["event", "snapshot", "branch", "merge", "semantic_version"]),
  type: z.string(),
  ref: z.string().nullable(),
  actorId: Uuid.nullable(),
  /** Human and machine edits are attributed distinctly (ch.10); never unknown. */
  actorKind: z.enum(["human", "agent", "service"]),
  summary: z.string(),
  documentRevision: z.number().int().nullable(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const AddReviewCommentRequest = z.strictObject({
  ...CommandMeta,
  nodeId: Uuid,
  body: z.string().min(1).max(4000),
});
export type AddReviewCommentRequest = z.infer<typeof AddReviewCommentRequest>;

export const CollabScope = z.enum(["layout", "notes"]);
export type CollabScope = z.infer<typeof CollabScope>;

/** Yjs update transport: base64-encoded binary updates. Layout and notes only; evidence semantics are never in a CRDT. */
export const CollabUpdateRequest = z.strictObject({
  update: z.string().min(1).max(2_000_000),
});
export const CollabPresenceRequest = z.strictObject({
  state: z.record(z.string(), z.unknown()).default({}),
});
