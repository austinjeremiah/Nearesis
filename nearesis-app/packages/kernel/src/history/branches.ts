import {
  BranchChangeRequest,
  CreateBranchRequest,
  DecideMergeRequest,
  ProposeMergeRequest,
  ResolveConflictRequest,
} from "@nearesis/contracts";
import type { MergeConflict, ObjectChange } from "@nearesis/contracts";
import { canAdmin } from "../auth.ts";
import type { Session } from "../auth.ts";
import type { Db, Tx } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { noWorkspaceAccess } from "../workspace.ts";
import { applySemanticChange, endpointExists } from "./graph-ops.ts";
import type { CommandOpts } from "./graph-ops.ts";
import { HistoryRunner, idFor, parseBody } from "./runner.ts";
import type { HistoryCtx } from "./runner.ts";
import { captureLiveObjects, diffObjects, hashOf } from "./snapshots.ts";
import type { ObjectMap, SnapshotPayload } from "./snapshots.ts";

type OverlayEntry = { op: "set"; value: unknown } | { op: "delete" };
type Overlay = Record<string, OverlayEntry>;

const MAX_OVERLAY_BYTES = 2_000_000;
const MAX_VALUE_BYTES = 200_000;
const OBJECT_ID = /^(node|panel|metric|edge):[^\s]{1,280}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NODE_KINDS = new Set([
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
const RELATIONS = new Set([
  "supports",
  "contradicts",
  "derived_from",
  "monitors",
  "references",
  "reproduces",
  "supersedes",
]);

const semverMajor = (v: string): string => v.replace(/^v/, "").split(".")[0] ?? v;

const bad = (reason: string, msg: string) => new KernelError("VALIDATION_FAILED", reason, msg);

function validateValue(objectId: string, value: unknown): void {
  if (JSON.stringify(value ?? null).length > MAX_VALUE_BYTES)
    throw bad("VALUE_TOO_LARGE", `Value for ${objectId} is too large.`);
  const v = value as Record<string, unknown> | null;
  const kind = objectId.slice(0, objectId.indexOf(":"));
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw bad("INVALID_OBJECT_VALUE", `${objectId} must be an object.`);
  if (kind === "node") {
    if (
      typeof v.kind !== "string" ||
      !NODE_KINDS.has(v.kind) ||
      typeof v.label !== "string" ||
      !v.label ||
      v.label.length > 500
    )
      throw bad("INVALID_OBJECT_VALUE", `${objectId} needs a valid kind and label.`);
    if (!UUID.test(objectId.slice(5))) throw bad("INVALID_OBJECT_ID", "node ids are uuids.");
  } else if (kind === "metric") {
    if (typeof v.version !== "string" || !v.version)
      throw bad("INVALID_OBJECT_VALUE", `${objectId} needs a version.`);
  } else if (kind === "edge") {
    const [from, to, rel] = objectId.slice(5).split("|");
    if (
      !from ||
      !to ||
      !rel ||
      !UUID.test(from) ||
      !UUID.test(to) ||
      !RELATIONS.has(rel) ||
      v.relation !== rel
    )
      throw bad(
        "INVALID_OBJECT_VALUE",
        `${objectId} must be edge:<from>|<to>|<relation> with a matching relation.`,
      );
  }
}

function materialize(base: ObjectMap, overlay: Overlay): ObjectMap {
  const out: ObjectMap = { ...base };
  for (const [id, e] of Object.entries(overlay)) {
    if (e.op === "delete") delete out[id];
    else out[id] = e.value;
  }
  return out;
}

const iso = (d: unknown) => new Date(d as string).toISOString();

interface BranchRow {
  branch_id: string;
  name: string;
  base_snapshot_id: string;
  overlay: Overlay;
  overlay_revision: number;
  status: string;
}

export class BranchOps {
  constructor(
    private readonly db: Db,
    private readonly runner: HistoryRunner,
  ) {}

  private tenant(s: Session) {
    return { orgId: s.principal.orgId, userId: s.userId };
  }

  private async baseObjects(tx: Tx, workspaceId: string, snapshotId: string): Promise<ObjectMap> {
    const r = (
      await tx.query(
        "SELECT payload -> 'objects' AS objects FROM history_snapshots WHERE id = $1 AND workspace_id = $2",
        [snapshotId, workspaceId],
      )
    ).rows[0];
    if (!r) throw noWorkspaceAccess();
    if (!r.objects)
      throw new KernelError(
        "NOT_FOUND",
        "VINTAGE_UNAVAILABLE",
        "The base snapshot was removed by a retention purge.",
      );
    return r.objects as ObjectMap;
  }

  private async branchRow(
    tx: Tx,
    workspaceId: string,
    branchId: string,
    lock = false,
  ): Promise<BranchRow & { parent: string | null }> {
    const r = (
      await tx.query(
        `SELECT hb.branch_id, hb.name, hb.base_snapshot_id, hb.overlay, hb.overlay_revision, b.status, b.parent_branch_id AS parent
           FROM history_branches hb JOIN branches b ON b.id = hb.branch_id
          WHERE hb.branch_id = $1 AND hb.workspace_id = $2 ${lock ? "FOR UPDATE OF hb" : ""}`,
        [branchId, workspaceId],
      )
    ).rows[0];
    if (!r) throw noWorkspaceAccess();
    return r;
  }

  private async branchObjects(tx: Tx, workspaceId: string, b: BranchRow): Promise<ObjectMap> {
    return materialize(await this.baseObjects(tx, workspaceId, b.base_snapshot_id), b.overlay);
  }

  // ---- commands ------------------------------------------------------------------------------------------------

  /** Branch from an exact snapshot: parent lineage is recorded, the parent's state is never written. */
  async create(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(CreateBranchRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "branch.create",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        const snap = (
          await ctx.tx.query(
            "SELECT id, branch_id, event_seq, data_vintage, created_at FROM history_snapshots WHERE id = $1 AND workspace_id = $2",
            [p.fromSnapshotId, ctx.workspace.id],
          )
        ).rows[0];
        if (!snap) throw noWorkspaceAccess();
        const id = p.branchId ?? idFor(ctx.commandId, "branch");
        try {
          await ctx.tx.query("SAVEPOINT br_ins");
          await ctx.tx.query(
            `INSERT INTO branches(id, org_id, workspace_id, parent_branch_id, base_event_seq, created_by)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [id, ctx.workspace.orgId, ctx.workspace.id, snap.branch_id, snap.event_seq, ctx.session.userId],
          );
          await ctx.tx.query(
            `INSERT INTO history_branches(branch_id, org_id, workspace_id, name, description, base_snapshot_id, input_version_map)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              id,
              ctx.workspace.orgId,
              ctx.workspace.id,
              p.name,
              p.description ?? null,
              snap.id,
              // Frozen at fork time: the semantic version map and source snapshot of the base snapshot.
              JSON.stringify({
                semanticPins: snap.data_vintage.semanticPins,
                sourceSnapshot: snap.data_vintage.sourceSnapshot,
              }),
            ],
          );
          // The branch's agent memory scope receives a snapshot copy of the summaries that existed at the snapshot,
          // under new ids. It has no live access to the parent's memory after the fork (ch.05).
          await ctx.tx.query(
            `INSERT INTO branch_memory_items(id, org_id, workspace_id, branch_id, copied_from, body, source_refs, author_kind)
             SELECT gen_random_uuid(), org_id, workspace_id, $1, id, body, source_refs, author_kind
               FROM history_summaries WHERE workspace_id = $2 AND created_at <= $3`,
            [id, ctx.workspace.id, snap.created_at],
          );
          await ctx.tx.query("RELEASE SAVEPOINT br_ins");
        } catch (e) {
          await ctx.tx.query("ROLLBACK TO SAVEPOINT br_ins");
          if ((e as { code?: string }).code === "23505")
            throw new KernelError(
              "DOMAIN_INVARIANT",
              "BRANCH_EXISTS",
              "A branch with that name or id already exists.",
            );
          throw e;
        }
        return {
          eventType: "workspace.updated",
          data: {
            change: "branch.created",
            branchId: id,
            parentBranchId: snap.branch_id,
            baseSnapshotId: snap.id,
          },
          result: { branchId: id, parentBranchId: snap.branch_id, baseSnapshotId: snap.id },
        };
      },
    });
  }

  /** Change a branch overlay (a model branch altering a metric definition or exclusion filter, a claim, a panel). */
  async change(
    session: Session,
    workspaceId: string,
    branchId: string,
    body: unknown,
    opts: CommandOpts = {},
  ) {
    const p = parseBody(BranchChangeRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "branch.change",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: { branchId, ...p },
      handle: async (ctx) => {
        const b = await this.branchRow(ctx.tx, ctx.workspace.id, branchId, true);
        if (b.status !== "active")
          throw new KernelError("DOMAIN_INVARIANT", "BRANCH_NOT_ACTIVE", `Branch is ${b.status}.`);
        const base = await this.baseObjects(ctx.tx, ctx.workspace.id, b.base_snapshot_id);
        const overlay: Overlay = { ...b.overlay };
        for (const op of p.ops) {
          if (!OBJECT_ID.test(op.objectId))
            throw bad("INVALID_OBJECT_ID", `Unsupported object id ${op.objectId}.`);
          if (op.op === "set") {
            validateValue(op.objectId, op.value);
            if (hashOf(base[op.objectId]) === hashOf(op.value)) delete overlay[op.objectId];
            else overlay[op.objectId] = { op: "set", value: op.value };
          } else if (base[op.objectId] === undefined) delete overlay[op.objectId];
          else overlay[op.objectId] = { op: "delete" };
        }
        if (JSON.stringify(overlay).length > MAX_OVERLAY_BYTES)
          throw bad("OVERLAY_TOO_LARGE", "Branch overlay too large.");
        const rev = b.overlay_revision + 1;
        await ctx.tx.query(
          "UPDATE history_branches SET overlay = $2, overlay_revision = $3 WHERE branch_id = $1",
          [branchId, JSON.stringify(overlay), rev],
        );
        return {
          eventType: "workspace.updated",
          data: { change: "branch.changed", branchId, overlayRevision: rev, opCount: p.ops.length },
          result: { branchId, overlayRevision: rev, changedObjects: Object.keys(overlay).length },
        };
      },
    });
  }

  async proposeMerge(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(ProposeMergeRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "merge.propose",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        const src = await this.branchRow(ctx.tx, ctx.workspace.id, p.sourceBranchId);
        if (src.status !== "active")
          throw new KernelError("DOMAIN_INVARIANT", "BRANCH_NOT_ACTIVE", `Source branch is ${src.status}.`);
        const mainId = ctx.workspace.activeBranchId;
        const targetId = p.targetBranchId ?? mainId;
        if (!targetId) throw new KernelError("DOMAIN_INVARIANT", "NO_TARGET", "No merge target.");
        if (targetId === src.branch_id) throw bad("SELF_MERGE", "A branch cannot merge into itself.");
        const theirs = await this.targetObjects(ctx.tx, ctx.workspace.id, targetId, mainId);
        const base = await this.baseObjects(ctx.tx, ctx.workspace.id, src.base_snapshot_id);
        const ours = materialize(base, src.overlay);
        const changes: Array<ObjectChange & { theirsHash: string }> = [];
        const conflicts: Array<MergeConflict & { theirsHash: string }> = [];
        const hashDiffs: Array<{ objectId: string; before: string; after: string }> = [];
        let verdictChange = false;
        let certifiedVerdictChange = false;
        const excluded: Array<{
          objectId: string;
          reason: string;
          reasonCode: string;
          from: string;
          to: string;
        }> = [];
        for (const c of diffObjects(base, ours)) {
          const id = c.objectId;
          const b = base[id];
          const o = ours[id];
          const t = theirs.objects[id];
          const th = hashOf(t);
          hashDiffs.push({ objectId: id, before: hashOf(b), after: hashOf(o) });
          // Policy and semver check (ch.10): a metric version that crosses a major version of the target's current
          // definition is not appended; it is excluded with its reason and left for a deliberate migration.
          if (id.startsWith("metric:") && o !== undefined) {
            const targetV = (t as { version?: string } | undefined)?.version;
            const ourV = (o as { version?: string }).version;
            if (targetV && ourV && semverMajor(targetV) !== semverMajor(ourV)) {
              excluded.push({
                objectId: id,
                reasonCode: "SEMVER_INCOMPATIBLE",
                reason: `metric version ${targetV} -> ${ourV} crosses a major version; not appended`,
                from: targetV,
                to: ourV,
              });
              continue;
            }
          }
          const verdictOf = (v: unknown) =>
            (v as { data?: { verdict?: unknown } } | undefined)?.data?.verdict ?? null;
          const isClaim = (v: unknown) => (v as { kind?: string } | undefined)?.kind === "claim";
          if ((isClaim(b) || isClaim(o)) && hashOf(verdictOf(b)) !== hashOf(verdictOf(o))) {
            verdictChange = true;
            const certified = (v: unknown) =>
              (v as { data?: { certified?: unknown } } | undefined)?.data?.certified === true;
            if (certified(b) || certified(o)) certifiedVerdictChange = true;
          }
          if (th === hashOf(o)) continue; // target already has this exact value
          if (th === hashOf(b)) changes.push({ ...c, theirsHash: th });
          else
            conflicts.push({
              objectId: id,
              base: b ?? null,
              ours: o ?? null,
              theirs: t ?? null,
              resolution: "unresolved",
              theirsHash: th,
            });
        }
        const required = ["human_acceptance"];
        if (verdictChange) required.push("verdict_change_acknowledgement");
        if (certifiedVerdictChange) required.push("certified_verdict_approval");
        if (conflicts.length) required.push("conflict_review");
        const id = p.proposalId ?? idFor(ctx.commandId, "proposal");
        await ctx.tx.query(
          `INSERT INTO history_merge_proposals(id, org_id, workspace_id, source_branch_id, target_branch_id, base_snapshot_id,
             changes, conflicts, evidence_hash_diffs, upstream, required_approvals, created_by, excluded)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id,
            ctx.workspace.orgId,
            ctx.workspace.id,
            src.branch_id,
            targetId,
            src.base_snapshot_id,
            JSON.stringify(changes),
            JSON.stringify(conflicts),
            JSON.stringify(hashDiffs),
            JSON.stringify({
              targetOverlayRevision: theirs.overlayRevision,
              targetEventSeq: theirs.eventSeq,
            }),
            JSON.stringify(required),
            ctx.session.userId,
            JSON.stringify(excluded),
          ],
        );
        return {
          eventType: "workspace.updated",
          data: {
            change: "merge.proposed",
            proposalId: id,
            conflictCount: conflicts.length,
            changeCount: changes.length,
            excludedCount: excluded.length,
          },
          result: {
            proposalId: id,
            conflictCount: conflicts.length,
            changeCount: changes.length,
            excludedCount: excluded.length,
          },
        };
      },
    });
  }

  private async targetObjects(tx: Tx, workspaceId: string, targetId: string, mainId: string | null) {
    const eventSeq = (
      await tx.query<{ seq: number }>(
        "SELECT coalesce(max(seq),0) AS seq FROM workspace_events WHERE workspace_id = $1",
        [workspaceId],
      )
    ).rows[0]!.seq;
    if (targetId === mainId)
      return {
        objects: await captureLiveObjects(tx, workspaceId, mainId),
        overlayRevision: 0,
        eventSeq,
        isMain: true,
      };
    const t = await this.branchRow(tx, workspaceId, targetId);
    if (t.status !== "active")
      throw new KernelError("DOMAIN_INVARIANT", "BRANCH_NOT_ACTIVE", `Target branch is ${t.status}.`);
    return {
      objects: await this.branchObjects(tx, workspaceId, t),
      overlayRevision: t.overlay_revision,
      eventSeq,
      isMain: false,
    };
  }

  async resolveConflict(
    session: Session,
    workspaceId: string,
    proposalId: string,
    body: unknown,
    opts: CommandOpts = {},
  ) {
    const p = parseBody(ResolveConflictRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "merge.resolve_conflict",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: { proposalId, ...p },
      handle: async (ctx) => {
        const pr = await this.proposal(ctx.tx, ctx.workspace.id, proposalId, true);
        if (pr.status !== "open")
          throw new KernelError("DOMAIN_INVARIANT", "PROPOSAL_CLOSED", "Proposal is closed.");
        const required = pr.required_approvals as string[];
        // Changing a certified verdict needs a human who holds approval authority (owner or admin).
        if (required.includes("certified_verdict_approval") && !canAdmin(ctx.session.role))
          throw new KernelError(
            "FORBIDDEN",
            "APPROVAL_AUTHORITY_REQUIRED",
            "Changing a certified verdict needs an approver (owner or admin).",
          );
        const conflicts = pr.conflicts as Array<MergeConflict & { theirsHash: string }>;
        const c = conflicts.find((x) => x.objectId === p.objectId);
        if (!c) throw new KernelError("NOT_FOUND", "NO_SUCH_CONFLICT", "No such conflict.");
        if (p.resolution === "keep_both" && !p.objectId.startsWith("node:"))
          throw bad("KEEP_BOTH_UNSUPPORTED", "keep_both is only supported for evidence nodes and claims.");
        if (p.resolution === "keep_both" && c.ours === null)
          throw bad("KEEP_BOTH_UNSUPPORTED", "Nothing to keep: the source side deleted this object.");
        c.resolution = p.resolution;
        await ctx.tx.query("UPDATE history_merge_proposals SET conflicts = $2 WHERE id = $1", [
          proposalId,
          JSON.stringify(conflicts),
        ]);
        const open = conflicts.filter((x) => x.resolution === "unresolved").length;
        return {
          eventType: "workspace.updated",
          data: {
            change: "merge.conflict_resolved",
            proposalId,
            objectId: p.objectId,
            resolution: p.resolution,
          },
          result: { proposalId, unresolved: open },
        };
      },
    });
  }

  private async proposal(tx: Tx, workspaceId: string, id: string, lock = false) {
    const r = (
      await tx.query(
        `SELECT * FROM history_merge_proposals WHERE id = $1 AND workspace_id = $2 ${lock ? "FOR UPDATE" : ""}`,
        [id, workspaceId],
      )
    ).rows[0];
    if (!r) throw noWorkspaceAccess();
    return r;
  }

  /**
   * Accept a merge proposal. A human must accept; unresolved conflicts block it (no silent overwrite); a changed claim
   * verdict needs explicit acknowledgement; a target that moved since the proposal makes it stale.
   */
  async acceptMerge(
    session: Session,
    workspaceId: string,
    proposalId: string,
    body: unknown,
    opts: CommandOpts = {},
  ) {
    const p = parseBody(DecideMergeRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "merge.accept",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: { proposalId, ...p },
      humanOnly: true,
      handle: async (ctx) => {
        const pr = await this.proposal(ctx.tx, ctx.workspace.id, proposalId, true);
        if (pr.status !== "open")
          throw new KernelError("DOMAIN_INVARIANT", "PROPOSAL_CLOSED", "Proposal is closed.");
        const required = pr.required_approvals as string[];
        // Changing a certified verdict needs a human who holds approval authority (owner or admin).
        if (required.includes("certified_verdict_approval") && !canAdmin(ctx.session.role))
          throw new KernelError(
            "FORBIDDEN",
            "APPROVAL_AUTHORITY_REQUIRED",
            "Changing a certified verdict needs an approver (owner or admin).",
          );
        const conflicts = pr.conflicts as Array<MergeConflict & { theirsHash: string }>;
        const unresolved = conflicts.filter((c) => c.resolution === "unresolved");
        if (unresolved.length)
          throw new KernelError(
            "DOMAIN_INVARIANT",
            "MERGE_CONFLICTS_UNRESOLVED",
            "Conflict review is required before this merge.",
            {
              details: unresolved.map((c) => ({ path: c.objectId, issue: "unresolved conflict" })),
              nextAction: "Resolve each conflict (ours, theirs or keep_both), then accept.",
            },
          );
        if (required.includes("verdict_change_acknowledgement") && !p.acknowledgeVerdictChange)
          throw new KernelError(
            "APPROVAL_REQUIRED",
            "VERDICT_CHANGE_NEEDS_ACK",
            "This merge changes a claim verdict; acknowledge it explicitly.",
          );
        const src = await this.branchRow(ctx.tx, ctx.workspace.id, pr.source_branch_id, true);
        const mainId = ctx.workspace.activeBranchId;
        const target = await this.targetObjects(ctx.tx, ctx.workspace.id, pr.target_branch_id, mainId);
        const changes = pr.changes as Array<ObjectChange & { theirsHash: string }>;
        // Stale check: every touched object must still be exactly what the proposal saw on the target.
        for (const c of [...changes, ...conflicts])
          if (hashOf(target.objects[c.objectId]) !== c.theirsHash)
            throw new KernelError(
              "STALE_VERSION",
              "MERGE_PROPOSAL_STALE",
              "The target changed since this proposal; propose again.",
              {
                retryable: false,
                nextAction: "Create a new merge proposal against the current target.",
              },
            );
        const base = await this.baseObjects(ctx.tx, ctx.workspace.id, src.base_snapshot_id);
        const ours = materialize(base, src.overlay);
        const ops: Array<{ objectId: string; entry: OverlayEntry }> = [];
        const toOp = (id: string, value: unknown): OverlayEntry =>
          value === undefined ? { op: "delete" } : { op: "set", value };
        for (const c of changes)
          ops.push({ objectId: c.objectId, entry: toOp(c.objectId, ours[c.objectId]) });
        for (const c of conflicts) {
          if (c.resolution === "ours")
            ops.push({ objectId: c.objectId, entry: toOp(c.objectId, ours[c.objectId]) });
          else if (c.resolution === "keep_both") {
            const o = ours[c.objectId] as { label: string; data?: Record<string, unknown> };
            ops.push({
              objectId: `node:${idFor(proposalId, c.objectId)}`,
              entry: {
                op: "set",
                value: {
                  ...o,
                  label: `${o.label} [${src.name}]`.slice(0, 500),
                  data: {
                    ...(o.data ?? {}),
                    mergedFromBranch: src.branch_id,
                    preservesConflictWith: c.objectId,
                  },
                },
              },
            });
          }
        }
        const deferred: string[] = [];
        if (target.isMain) {
          for (const o of ops) {
            if (!(await this.applyToMain(ctx, o.objectId, o.entry))) deferred.push(o.objectId);
          }
        } else {
          const t = await this.branchRow(ctx.tx, ctx.workspace.id, pr.target_branch_id, true);
          const tbase = await this.baseObjects(ctx.tx, ctx.workspace.id, t.base_snapshot_id);
          const overlay: Overlay = { ...t.overlay };
          for (const o of ops) {
            if (o.entry.op === "set" && hashOf(tbase[o.objectId]) === hashOf(o.entry.value))
              delete overlay[o.objectId];
            else if (o.entry.op === "delete" && tbase[o.objectId] === undefined) delete overlay[o.objectId];
            else overlay[o.objectId] = o.entry;
          }
          await ctx.tx.query(
            "UPDATE history_branches SET overlay = $2, overlay_revision = overlay_revision + 1 WHERE branch_id = $1",
            [t.branch_id, JSON.stringify(overlay)],
          );
        }
        await ctx.tx.query(
          "UPDATE history_merge_proposals SET status = 'accepted', decided_by = $2, decided_at = now() WHERE id = $1",
          [proposalId, ctx.session.userId],
        );
        await ctx.tx.query("UPDATE branches SET status = 'merged' WHERE id = $1", [src.branch_id]);
        return {
          eventType: "workspace.updated",
          data: { change: "merge.accepted", proposalId, applied: ops.length - deferred.length, deferred },
          result: { proposalId, applied: ops.length - deferred.length, deferredObjects: deferred },
        };
      },
    });
  }

  /** Returns false when the object kind cannot be applied to live state in-place (reported as deferred, never dropped silently). */
  private async applyToMain(ctx: HistoryCtx, objectId: string, entry: OverlayEntry): Promise<boolean> {
    const { tx, workspace, session } = ctx;
    const kind = objectId.slice(0, objectId.indexOf(":"));
    const rest = objectId.slice(objectId.indexOf(":") + 1);
    if (kind === "node") {
      if (entry.op === "delete") {
        await tx.query(
          "UPDATE evidence_nodes SET tombstone = true, tombstone_reason = 'removed by merge' WHERE id = $1 AND workspace_id = $2",
          [rest, workspace.id],
        );
        return true;
      }
      const v = entry.value as {
        kind: string;
        label: string;
        data?: unknown;
        semanticPins?: unknown;
        tombstone?: boolean;
        rawObjectHash?: string;
      };
      await tx.query(
        `INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label, data, semantic_pins, tombstone, raw_object_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, label = EXCLUDED.label, data = EXCLUDED.data,
           semantic_pins = EXCLUDED.semantic_pins, tombstone = EXCLUDED.tombstone,
           raw_object_hash = EXCLUDED.raw_object_hash
         WHERE evidence_nodes.workspace_id = EXCLUDED.workspace_id`,
        [
          rest,
          workspace.orgId,
          workspace.id,
          v.kind,
          v.label,
          JSON.stringify(v.data ?? {}),
          JSON.stringify(v.semanticPins ?? {}),
          v.tombstone ?? false,
          v.rawObjectHash ?? null,
        ],
      );
      return true;
    }
    if (kind === "edge") {
      if (entry.op === "delete") return false;
      const [from, to, rel] = rest.split("|") as [string, string, string];
      if (!(await endpointExists(tx, workspace.id, from)) || !(await endpointExists(tx, workspace.id, to)))
        throw new KernelError("VALIDATION_FAILED", "ORPHAN_EVIDENCE_EDGE", "Merged edge would be orphaned.", {
          details: [{ path: objectId, issue: "endpoint does not resolve to a persisted node" }],
        });
      await tx.query(
        `INSERT INTO evidence_edges(id, org_id, workspace_id, from_node, to_node, relation, created_by, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (workspace_id, from_node, to_node, relation) DO NOTHING`,
        [
          idFor(ctx.commandId, objectId),
          workspace.orgId,
          workspace.id,
          from,
          to,
          rel,
          session.userId,
          (entry.value as { reason?: string }).reason ?? null,
        ],
      );
      return true;
    }
    if (kind === "metric") {
      if (entry.op === "delete") return false;
      await applySemanticChange(ctx, rest, (entry.value as { version: string }).version);
      return true;
    }
    return false; // panels: canvas changes must go through a canvas patch against the live document
  }

  async rejectMerge(
    session: Session,
    workspaceId: string,
    proposalId: string,
    body: unknown,
    opts: CommandOpts = {},
  ) {
    const p = parseBody(DecideMergeRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "merge.reject",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: { proposalId, ...p },
      handle: async (ctx) => {
        const pr = await this.proposal(ctx.tx, ctx.workspace.id, proposalId, true);
        if (pr.status !== "open")
          throw new KernelError("DOMAIN_INVARIANT", "PROPOSAL_CLOSED", "Proposal is closed.");
        await ctx.tx.query(
          "UPDATE history_merge_proposals SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1",
          [proposalId, ctx.session.userId],
        );
        return {
          eventType: "workspace.updated",
          data: { change: "merge.rejected", proposalId },
          result: { proposalId },
        };
      },
    });
  }

  // ---- reads ---------------------------------------------------------------------------------------------------

  async list(session: Session, workspaceId: string) {
    return this.db.tx(this.tenant(session), async (tx) => {
      const ws = (
        await tx.query("SELECT active_branch_id, created_at, created_by FROM workspaces WHERE id = $1", [
          workspaceId,
        ])
      ).rows[0];
      if (!ws) throw noWorkspaceAccess();
      const rows = (
        await tx.query(
          `SELECT b.id, b.parent_branch_id, b.base_event_seq, b.status, hb.created_at, b.created_by,
                  hb.name, hb.base_snapshot_id, hb.overlay_revision, hb.description
             FROM branches b LEFT JOIN history_branches hb ON hb.branch_id = b.id
            WHERE b.workspace_id = $1 ORDER BY hb.created_at NULLS FIRST, b.id`,
          [workspaceId],
        )
      ).rows;
      return rows.map((r) => ({
        id: r.id,
        workspaceId,
        name: r.name ?? "main",
        isMain: r.id === ws.active_branch_id,
        description: r.description ?? null,
        parentBranchId: r.parent_branch_id,
        baseSnapshotId: r.base_snapshot_id ?? null,
        baseEventSeq: r.base_event_seq,
        status: r.status,
        overlayRevision: r.overlay_revision ?? 0,
        createdAt: iso(r.created_at ?? ws.created_at),
        createdBy: r.created_by,
      }));
    });
  }

  /** Materialized branch view and its diff against the base snapshot (parent state is untouched by definition). */
  async view(session: Session, workspaceId: string, branchId: string) {
    return this.db.tx(this.tenant(session), async (tx) => {
      const b = await this.branchRow(tx, workspaceId, branchId);
      const base = await this.baseObjects(tx, workspaceId, b.base_snapshot_id);
      const objects = materialize(base, b.overlay);
      const meta = (
        await tx.query<{ base_event_seq: number; input_version_map: unknown }>(
          `SELECT b.base_event_seq, hb.input_version_map FROM branches b JOIN history_branches hb ON hb.branch_id = b.id
            WHERE b.id = $1`,
          [branchId],
        )
      ).rows[0]!;
      return {
        branchId,
        name: b.name,
        status: b.status,
        baseEventSeq: meta.base_event_seq,
        inputVersionMap: meta.input_version_map,
        baseSnapshotId: b.base_snapshot_id,
        overlayRevision: b.overlay_revision,
        parentBranchId: b.parent,
        diff: diffObjects(base, objects),
        objects,
      };
    });
  }

  /** Agent memory scope of a branch: a snapshot copy made at fork time. */
  async memory(session: Session, workspaceId: string, branchId: string) {
    return this.db.tx(this.tenant(session), async (tx) => {
      await this.branchRow(tx, workspaceId, branchId);
      return (
        await tx.query(
          `SELECT id, copied_from AS "copiedFrom", body, source_refs AS "sourceRefs", author_kind AS "authorKind"
             FROM branch_memory_items WHERE branch_id = $1 AND workspace_id = $2 ORDER BY created_at, id`,
          [branchId, workspaceId],
        )
      ).rows;
    });
  }

  /**
   * Execute the branch's panels: base snapshot pin (watermarks, semantic versions) plus the branch overlay, which may
   * replace a metric version or add exclusion filters. The parent's catalog and results are never consulted or changed.
   */
  async executePanels(
    session: Session,
    workspaceId: string,
    branchId: string,
    executor: import("./pinned.ts").PanelExecutor,
  ) {
    const { objects, vintage } = await this.db.tx(this.tenant(session), async (tx) => {
      const b = await this.branchRow(tx, workspaceId, branchId);
      const base = await this.baseObjects(tx, workspaceId, b.base_snapshot_id);
      const v = (
        await tx.query<{ data_vintage: import("@nearesis/contracts").DataVintage }>(
          "SELECT data_vintage FROM history_snapshots WHERE id = $1",
          [b.base_snapshot_id],
        )
      ).rows[0]!.data_vintage;
      return { objects: materialize(base, b.overlay), vintage: v };
    });
    const versions: Record<string, string> = { ...vintage.semanticPins };
    const exclusions: Record<string, unknown> = {};
    for (const [id, val] of Object.entries(objects)) {
      if (!id.startsWith("metric:")) continue;
      const m = val as { version: string; exclusions?: Record<string, unknown> };
      versions[id.slice(7)] = m.version;
      Object.assign(exclusions, m.exclusions ?? {});
    }
    const out = [];
    for (const [id, spec] of Object.entries(objects)) {
      if (!id.startsWith("panel:")) continue;
      const panel = spec as import("@nearesis/contracts").PanelSpec;
      const result = await executor.execute(panel, {
        watermark: vintage.sourceSnapshot?.watermark ?? null,
        semanticVersions: versions,
        exclusions,
      });
      out.push({ panelId: panel.panelId, result, resultHash: hashOf(result) });
    }
    return out;
  }

  async diff(session: Session, workspaceId: string, branchId: string, against?: string) {
    return this.db.tx(this.tenant(session), async (tx) => {
      const b = await this.branchRow(tx, workspaceId, branchId);
      const ours = await this.branchObjects(tx, workspaceId, b);
      let other: ObjectMap;
      let againstLabel: string;
      if (!against || against === "base") {
        other = await this.baseObjects(tx, workspaceId, b.base_snapshot_id);
        againstLabel = `snapshot:${b.base_snapshot_id}`;
      } else {
        const ws = (await tx.query("SELECT active_branch_id FROM workspaces WHERE id = $1", [workspaceId]))
          .rows[0];
        if (!ws) throw noWorkspaceAccess();
        if (against === ws.active_branch_id)
          other = await captureLiveObjects(tx, workspaceId, ws.active_branch_id);
        else
          other = await this.branchObjects(tx, workspaceId, await this.branchRow(tx, workspaceId, against));
        againstLabel = `branch:${against}`;
      }
      return { branchId, against: againstLabel, changes: diffObjects(other, ours) };
    });
  }

  async getProposal(session: Session, workspaceId: string, proposalId: string) {
    return this.db.tx(this.tenant(session), async (tx) => {
      const r = await this.proposal(tx, workspaceId, proposalId);
      const strip = <T extends { theirsHash?: string }>(x: T) => {
        const { theirsHash: _t, ...rest } = x;
        void _t;
        return rest;
      };
      return {
        id: r.id,
        workspaceId,
        sourceBranchId: r.source_branch_id,
        targetBranchId: r.target_branch_id,
        baseSnapshotId: r.base_snapshot_id,
        status: r.status,
        changes: (r.changes as Array<ObjectChange & { theirsHash?: string }>).map(strip),
        conflicts: (r.conflicts as Array<MergeConflict & { theirsHash?: string }>).map(strip),
        evidenceHashDiffs: r.evidence_hash_diffs,
        upstreamRevisions: r.upstream,
        requiredApprovals: r.required_approvals,
        excluded: r.excluded,
        createdAt: iso(r.created_at),
        decidedAt: r.decided_at ? iso(r.decided_at) : null,
      };
    });
  }

  async listProposals(session: Session, workspaceId: string) {
    return this.db.tx(this.tenant(session), async (tx) => {
      const w = await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId]);
      if (!w.rows[0]) throw noWorkspaceAccess();
      const r = await tx.query(
        `SELECT id, source_branch_id, target_branch_id, status, created_at, decided_at,
                jsonb_array_length(conflicts) AS conflicts, jsonb_array_length(changes) AS changes
           FROM history_merge_proposals WHERE workspace_id = $1 ORDER BY created_at, id`,
        [workspaceId],
      );
      return r.rows.map((x) => ({
        id: x.id,
        sourceBranchId: x.source_branch_id,
        targetBranchId: x.target_branch_id,
        status: x.status,
        conflictCount: x.conflicts,
        changeCount: x.changes,
        createdAt: iso(x.created_at),
        decidedAt: x.decided_at ? iso(x.decided_at) : null,
      }));
    });
  }
}

export type { SnapshotPayload };
