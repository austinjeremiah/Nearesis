import {
  AddEvidenceEdgeRequest,
  AddEvidenceNodeRequest,
  ResolveRecheckRequest,
  SemanticVersionChangeRequest,
} from "@nearesis/contracts";
import type { Tx } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { HistoryRunner, idFor, parseBody } from "./runner.ts";
import type { HistoryCtx } from "./runner.ts";
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

/** Dependents of `id`: nodes that depend on it (derived_from/reproduces point from dependent to dependency). */
function dependentsOf(
  id: string,
  edges: Array<{ from_node: string; to_node: string; relation: string }>,
): string[] {
  const out: string[] = [];
  for (const e of edges) {
    if ((e.relation === "derived_from" || e.relation === "reproduces") && e.to_node === id)
      out.push(e.from_node);
    if ((e.relation === "supports" || e.relation === "contradicts") && e.from_node === id)
      out.push(e.to_node);
  }
  return out;
}

export interface ImpactResult {
  metricId: string;
  toVersion: string;
  changed: boolean;
  flaggedNodeIds: string[];
}

/**
 * Impact analysis for a semantic-version change: nodes pinned to another version of the metric are flagged, then every
 * transitive dependent (cycle-safe) is flagged too. Exported so merge acceptance can reuse it inside its transaction.
 */
export async function applySemanticChange(
  ctx: HistoryCtx,
  metricId: string,
  toVersion: string,
): Promise<ImpactResult> {
  const { tx, workspace, session } = ctx;
  const cur = (
    await tx.query<{ version: string; seq: number }>(
      "SELECT version, seq FROM semantic_versions WHERE workspace_id = $1 AND metric_id = $2 ORDER BY seq DESC LIMIT 1",
      [workspace.id, metricId],
    )
  ).rows[0];
  if (cur?.version === toVersion) return { metricId, toVersion, changed: false, flaggedNodeIds: [] };
  await tx.query(
    "INSERT INTO semantic_versions(workspace_id, org_id, metric_id, seq, version, changed_by) VALUES ($1,$2,$3,$4,$5,$6)",
    [workspace.id, workspace.orgId, metricId, (cur?.seq ?? 0) + 1, toVersion, session.userId],
  );
  const direct = (
    await tx.query<{ id: string; v: string }>(
      `SELECT id, semantic_pins ->> $2 AS v FROM evidence_nodes
        WHERE workspace_id = $1 AND tombstone = false AND semantic_pins ? $2 AND semantic_pins ->> $2 <> $3`,
      [workspace.id, metricId, toVersion],
    )
  ).rows;
  const edges = (
    await tx.query<{ from_node: string; to_node: string; relation: string }>(
      "SELECT from_node, to_node, relation FROM evidence_edges WHERE workspace_id = $1",
      [workspace.id],
    )
  ).rows;
  const from = new Map<string, { via: "pinned" | "derived_from"; from: string | null }>();
  const queue: string[] = [];
  for (const d of direct) {
    from.set(d.id, { via: "pinned", from: d.v });
    queue.push(d.id);
  }
  while (queue.length) {
    const id = queue.shift()!;
    for (const dep of dependentsOf(id, edges)) {
      if (from.has(dep)) continue;
      from.set(dep, { via: "derived_from", from: cur?.version ?? null });
      queue.push(dep);
    }
  }
  const flagged: string[] = [];
  for (const [nodeId, info] of from) {
    // Only persisted evidence nodes are flagged (panels/markers have their own revision flows).
    const isNode = (
      await tx.query(
        "SELECT 1 FROM evidence_nodes WHERE id = $1 AND workspace_id = $2 AND tombstone = false",
        [nodeId, workspace.id],
      )
    ).rows.length;
    if (!isNode) continue;
    const r = await tx.query(
      `INSERT INTO evidence_node_flags(node_id, org_id, workspace_id, metric_id, from_version, to_version, via, flagged_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [nodeId, workspace.orgId, workspace.id, metricId, info.from, toVersion, info.via, session.userId],
    );
    if (r.rowCount) flagged.push(nodeId);
  }
  return { metricId, toVersion, changed: true, flaggedNodeIds: flagged };
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
          data: { change: "graph.node_added", nodeId: id, kind: p.kind },
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
          data: { change: "graph.edge_added", edgeId, relation: p.relation, tombstoned },
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
        const r = await applySemanticChange(ctx, p.metricId, p.toVersion);
        return {
          eventType: "claim.updated",
          data: {
            change: "graph.semantic_version_changed",
            metricId: p.metricId,
            toVersion: p.toVersion,
            flaggedCount: r.flaggedNodeIds.length,
          },
          result: r,
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
