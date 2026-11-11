import {
  AddEvidenceEdgeRequest,
  AddEvidenceNodeRequest,
  ResolveRecheckRequest,
  SemanticVersionChangeRequest,
  SetNodeRestrictionRequest,
  UpdateNodeDataRequest,
  CorrectNodeRequest,
} from "@nearesis/contracts";
import type { Tx } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { DEFAULT_REVALIDATION_CAP, dependentIndex, traverseDependents } from "./impact.ts";
import type { DepEdge } from "./impact.ts";
import { HistoryRunner, idFor, parseBody } from "./runner.ts";
import type { HistoryCtx } from "./runner.ts";
import { canAdmin } from "../auth.ts";
import type { Session } from "../auth.ts";

export interface CommandOpts {
  idempotencyKey?: string;
}

/** Does `id` resolve to a persisted object of this workspace (RLS-scoped)? Foreign and unknown ids look the same. */
export async function endpointExists(tx: Tx, workspaceId: string, id: string): Promise<boolean> {
  const q = async (sql: string) => (await tx.query(sql, [id, workspaceId])).rows.length > 0;
  if (await q("SELECT 1 FROM evidence_nodes WHERE id = $1 AND workspace_id = $2")) return true;
  if (await q("SELECT 1 FROM panel_specs WHERE id = $1 AND workspace_id = $2 AND removed_at IS NULL"))
    return true;
  if (await q("SELECT 1 FROM markers WHERE id = $1 AND workspace_id = $2")) return true;
  try {
    await tx.query("SAVEPOINT ep_agents");
    const hit = await q("SELECT 1 FROM runtime.tasks WHERE id = $1 AND workspace_id = $2");
    await tx.query("RELEASE SAVEPOINT ep_agents");
    return hit;
  } catch {
    await tx.query("ROLLBACK TO SAVEPOINT ep_agents");
    return false;
  }
}

const orphan = (which: string[]): KernelError =>
  new KernelError(
    "VALIDATION_FAILED",
    "ORPHAN_EVIDENCE_EDGE",
    "Evidence edges must link persisted nodes; use an explicit tombstone for a removed source.",
    { details: which.map((w) => ({ path: w, issue: "endpoint does not resolve to a persisted node" })) },
  );

export interface ImpactResult {
  metricId: string;
  toVersion: string;
  changed: boolean;
  flaggedNodeIds: string[];
  flaggedCount: number;
  /** Revalidation tasks: at most `cap` created now, the rest queued with a visible count. */
  revalidation: { created: number; queued: number; cap: number };
}

/**
 * Impact analysis for a semantic-version change: nodes pinned to another version of the metric are flagged, then every
 * transitive dependent (cycle-safe, iterative, set-based SQL) is flagged too and queued for bounded revalidation.
 * Exported so merge acceptance can reuse it inside its transaction.
 */
export async function applySemanticChange(
  ctx: HistoryCtx,
  metricId: string,
  toVersion: string,
  cap: number = DEFAULT_REVALIDATION_CAP,
): Promise<ImpactResult> {
  const { tx, workspace, session } = ctx;
  const none = (changed: boolean): ImpactResult => ({
    metricId,
    toVersion,
    changed,
    flaggedNodeIds: [],
    flaggedCount: 0,
    revalidation: { created: 0, queued: 0, cap },
  });
  const cur = (
    await tx.query<{ version: string; seq: number }>(
      "SELECT version, seq FROM semantic_versions WHERE workspace_id = $1 AND metric_id = $2 ORDER BY seq DESC LIMIT 1",
      [workspace.id, metricId],
    )
  ).rows[0];
  if (cur?.version === toVersion) return none(false);
  await tx.query(
    "INSERT INTO semantic_versions(workspace_id, org_id, metric_id, seq, version, changed_by) VALUES ($1,$2,$3,$4,$5,$6)",
    [workspace.id, workspace.orgId, metricId, (cur?.seq ?? 0) + 1, toVersion, session.userId],
  );
  const nodes = (
    await tx.query<{ id: string; v: string | null; tombstone: boolean }>(
      "SELECT id, semantic_pins ->> $2 AS v, tombstone FROM evidence_nodes WHERE workspace_id = $1",
      [workspace.id, metricId],
    )
  ).rows;
  const live = new Set(nodes.filter((n) => !n.tombstone).map((n) => n.id));
  const pinnedFrom = new Map<string, string>();
  for (const n of nodes) if (!n.tombstone && n.v !== null && n.v !== toVersion) pinnedFrom.set(n.id, n.v);
  const edges = (
    await tx.query<DepEdge>(
      "SELECT from_node, to_node, relation FROM evidence_edges WHERE workspace_id = $1",
      [workspace.id],
    )
  ).rows;
  const t = traverseDependents([...pinnedFrom.keys()], dependentIndex(edges));
  // Only persisted evidence nodes are flagged (panels/markers have their own revision flows).
  const ids = t.affected.map((a) => a.nodeId).filter((id) => live.has(id));
  if (!ids.length) return none(true);
  const fromV = ids.map((id) => pinnedFrom.get(id) ?? cur?.version ?? null);
  const via = ids.map((id) => (pinnedFrom.has(id) ? "pinned" : "derived_from"));
  const ins = await tx.query<{ node_id: string }>(
    `INSERT INTO evidence_node_flags(node_id, org_id, workspace_id, metric_id, from_version, to_version, via, flagged_by)
     SELECT u.id, $1, $2, $3, u.fv, $4, u.via, $5
       FROM unnest($6::uuid[], $7::text[], $8::text[]) AS u(id, fv, via)
     ON CONFLICT DO NOTHING RETURNING node_id`,
    [workspace.orgId, workspace.id, metricId, toVersion, session.userId, ids, fromV, via],
  );
  const flagged = new Set(ins.rows.map((r) => r.node_id));
  const flaggedIds = ids.filter((id) => flagged.has(id));
  const taskIds = flaggedIds.map((id) => idFor(ctx.commandId, `reval:${id}`));
  const status = flaggedIds.map((_, i) => (i < cap ? "created" : "queued"));
  await tx.query(
    `INSERT INTO revalidation_tasks(id, org_id, workspace_id, node_id, metric_id, to_version, status)
     SELECT u.id, $1, $2, u.node_id, $3, $4, u.status
       FROM unnest($5::uuid[], $6::uuid[], $7::text[]) AS u(id, node_id, status)
     ON CONFLICT DO NOTHING`,
    [workspace.orgId, workspace.id, metricId, toVersion, taskIds, flaggedIds, status],
  );
  const created = Math.min(cap, flaggedIds.length);
  return {
    metricId,
    toVersion,
    changed: true,
    flaggedNodeIds: flaggedIds.slice(0, 1000),
    flaggedCount: flaggedIds.length,
    revalidation: { created, queued: flaggedIds.length - created, cap },
  };
}

export class GraphOps {
  constructor(private readonly runner: HistoryRunner) {}

  async addNode(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(AddEvidenceNodeRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "graph.add_node",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        const id = p.nodeId ?? idFor(ctx.commandId, "node");
        await ctx.tx.query(
          `INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label, data, semantic_pins)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            ctx.workspace.orgId,
            ctx.workspace.id,
            p.kind,
            p.label,
            JSON.stringify(p.data),
            JSON.stringify(p.semanticPins),
          ],
        );
        return {
          eventType: p.kind === "claim" ? "claim.updated" : "evidence.verified",
          data: {
            change: "graph.node_added",
            nodeId: id,
            kind: p.kind,
            node: { kind: p.kind, label: p.label, data: p.data, semanticPins: p.semanticPins },
          },
          result: { nodeId: id },
        };
      },
    });
  }

  async addEdge(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(AddEvidenceEdgeRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "graph.add_edge",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        if (p.from === p.to)
          throw new KernelError(
            "VALIDATION_FAILED",
            "SELF_EDGE",
            "An evidence edge cannot link a node to itself.",
          );
        const missing: Array<"from" | "to"> = [];
        if (!(await endpointExists(ctx.tx, ctx.workspace.id, p.from))) missing.push("from");
        if (!(await endpointExists(ctx.tx, ctx.workspace.id, p.to))) missing.push("to");
        const tombstoned: string[] = [];
        if (missing.length) {
          if (!p.tombstoneMissing) throw orphan(missing);
          if (!p.tombstoneReason)
            throw new KernelError(
              "VALIDATION_FAILED",
              "TOMBSTONE_REASON_REQUIRED",
              "A tombstone needs an explicit reason.",
            );
          for (const side of missing) {
            const id = side === "from" ? p.from : p.to;
            const ins = await ctx.tx.query(
              `INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label, data, tombstone, tombstone_reason)
               VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,true,$6) ON CONFLICT (id) DO NOTHING`,
              [
                id,
                ctx.workspace.orgId,
                ctx.workspace.id,
                p.tombstoneKind,
                `TOMBSTONE ${id.slice(0, 8)}`,
                p.tombstoneReason,
              ],
            );
            // An id that exists but is invisible (other tenant) must read exactly like any other orphan.
            if (!ins.rowCount) throw orphan([side]);
            tombstoned.push(id);
          }
        }
        const edgeId = idFor(ctx.commandId, "edge");
        try {
          await ctx.tx.query("SAVEPOINT edge_ins");
          await ctx.tx.query(
            `INSERT INTO evidence_edges(id, org_id, workspace_id, from_node, to_node, relation, created_by, reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              edgeId,
              ctx.workspace.orgId,
              ctx.workspace.id,
              p.from,
              p.to,
              p.relation,
              ctx.session.userId,
              p.reason ?? null,
            ],
          );
          await ctx.tx.query("RELEASE SAVEPOINT edge_ins");
        } catch (e) {
          await ctx.tx.query("ROLLBACK TO SAVEPOINT edge_ins");
          if ((e as { code?: string }).code === "23505")
            throw new KernelError("DOMAIN_INVARIANT", "DUPLICATE_EDGE", "That relation already exists.");
          throw e;
        }
        return {
          eventType: "evidence.verified",
          data: {
            change: "graph.edge_added",
            edgeId,
            relation: p.relation,
            tombstoned,
            edge: { from: p.from, to: p.to, relation: p.relation, reason: p.reason ?? null },
            tombstones: tombstoned.map((id) => ({
              id,
              kind: p.tombstoneKind,
              reason: p.tombstoneReason ?? null,
            })),
          },
          result: { edgeId, tombstoned },
        };
      },
    });
  }

  async changeSemanticVersion(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(SemanticVersionChangeRequest, body);
    return this.runner.run<ImpactResult>(session, workspaceId, {
      commandType: "graph.change_semantic_version",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        const r = await applySemanticChange(ctx, p.metricId, p.toVersion, p.revalidationCap);
        return {
          eventType: "claim.updated",
          data: {
            change: "graph.semantic_version_changed",
            metricId: p.metricId,
            toVersion: p.toVersion,
            flaggedCount: r.flaggedCount,
          },
          result: r,
        };
      },
    });
  }

  async updateNodeData(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(UpdateNodeDataRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "graph.update_node_data",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        const cur = (
          await ctx.tx.query<{ kind: string; tombstone: boolean; data: Record<string, unknown> }>(
            "SELECT kind, tombstone, data FROM evidence_nodes WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
            [p.nodeId, ctx.workspace.id],
          )
        ).rows[0];
        if (!cur) throw new KernelError("NOT_FOUND", "NODE_NOT_FOUND", "No such evidence node.");
        if (cur.tombstone)
          throw new KernelError("DOMAIN_INVARIANT", "NODE_TOMBSTONED", "A tombstone cannot be edited.");
        const next = { ...cur.data, ...p.data };
        await ctx.tx.query("UPDATE evidence_nodes SET data = $2 WHERE id = $1", [
          p.nodeId,
          JSON.stringify(next),
        ]);
        return {
          eventType: cur.kind === "claim" ? "claim.updated" : "evidence.verified",
          data: {
            change: "graph.node_data_updated",
            nodeId: p.nodeId,
            keys: Object.keys(p.data),
            patch: p.data,
            reason: p.reason ?? null,
          },
          result: { nodeId: p.nodeId, keys: Object.keys(p.data) },
        };
      },
    });
  }

  /**
   * Compensating correction: updates the node and records a new event that references the event it corrects. The
   * original event is never touched (journal is append-only for the application role).
   */
  async correctNode(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(CorrectNodeRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "graph.correct_node",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        const orig = (
          await ctx.tx.query(
            "SELECT event_type, payload_hash FROM workspace_events WHERE workspace_id = $1 AND seq = $2",
            [ctx.workspace.id, p.correctsSeq],
          )
        ).rows[0];
        if (!orig) throw new KernelError("NOT_FOUND", "EVENT_NOT_FOUND", "No such event to correct.");
        const cur = (
          await ctx.tx.query<{ label: string; data: Record<string, unknown>; tombstone: boolean }>(
            "SELECT label, data, tombstone FROM evidence_nodes WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
            [p.nodeId, ctx.workspace.id],
          )
        ).rows[0];
        if (!cur) throw new KernelError("NOT_FOUND", "NODE_NOT_FOUND", "No such evidence node.");
        const label = p.label ?? cur.label;
        const data = p.data ? { ...cur.data, ...p.data } : cur.data;
        await ctx.tx.query("UPDATE evidence_nodes SET label = $2, data = $3 WHERE id = $1", [
          p.nodeId,
          label,
          JSON.stringify(data),
        ]);
        return {
          eventType: "claim.updated",
          data: {
            change: "graph.correction",
            nodeId: p.nodeId,
            corrects: { seq: p.correctsSeq, eventType: orig.event_type, payloadHash: orig.payload_hash },
            patch: { ...(p.label ? { label: p.label } : {}), ...(p.data ? { data: p.data } : {}) },
            reason: p.reason,
          },
          result: { nodeId: p.nodeId, correctsSeq: p.correctsSeq },
        };
      },
    });
  }

  async setRestriction(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(SetNodeRestrictionRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "graph.set_restriction",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        if (!canAdmin(ctx.session.role))
          throw new KernelError(
            "FORBIDDEN",
            "INSUFFICIENT_ROLE",
            "Only an owner or admin may restrict a node.",
          );
        const r = await ctx.tx.query(
          "UPDATE evidence_nodes SET restricted = $3 WHERE id = $1 AND workspace_id = $2",
          [p.nodeId, ctx.workspace.id, p.restricted],
        );
        if (!r.rowCount) throw new KernelError("NOT_FOUND", "NODE_NOT_FOUND", "No such evidence node.");
        await ctx.tx.query("DELETE FROM evidence_node_grants WHERE node_id = $1", [p.nodeId]);
        if (p.restricted)
          for (const u of new Set([...p.grantUserIds, ctx.session.userId]))
            await ctx.tx.query(
              `INSERT INTO evidence_node_grants(node_id, org_id, workspace_id, user_id, granted_by)
               VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
              [p.nodeId, ctx.workspace.orgId, ctx.workspace.id, u, ctx.session.userId],
            );
        return {
          eventType: "workspace.updated",
          data: { change: "graph.node_restriction", nodeId: p.nodeId, restricted: p.restricted },
          result: { nodeId: p.nodeId, restricted: p.restricted },
        };
      },
    });
  }

  async resolveRecheck(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(ResolveRecheckRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "graph.resolve_recheck",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        const r = await ctx.tx.query(
          `UPDATE evidence_node_flags SET resolved_at = now(), resolved_by = $3, resolution_note = $4
            WHERE workspace_id = $1 AND node_id = $2 AND resolved_at IS NULL`,
          [ctx.workspace.id, p.nodeId, ctx.session.userId, p.note ?? null],
        );
        if (!r.rowCount)
          throw new KernelError("NOT_FOUND", "NO_OPEN_FLAG", "No open recheck flag for that node.");
        return {
          eventType: "evidence.verified",
          data: { change: "graph.recheck_resolved", nodeId: p.nodeId },
          result: { nodeId: p.nodeId, resolved: r.rowCount },
        };
      },
    });
  }

  /** Open recheck flags (read inside a tenant tx supplied by the facade). */
  static async flags(tx: Tx, workspaceId: string) {
    return (
      await tx.query(
        `SELECT node_id AS "nodeId", metric_id AS "metricId", from_version AS "fromVersion", to_version AS "toVersion",
                via, flagged_at AS "flaggedAt"
           FROM evidence_node_flags WHERE workspace_id = $1 AND resolved_at IS NULL ORDER BY flagged_at, node_id`,
        [workspaceId],
      )
    ).rows;
  }
}
