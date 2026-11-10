import { EvidenceRelation } from "@nearesis/contracts";
import { z } from "zod";
import type { Session } from "./auth.ts";
import type { CommandHandler } from "./commands.ts";
import type { Db, Tx } from "./db/pool.ts";
import { KernelError } from "./errors.ts";
import { noWorkspaceAccess, zodDetails } from "./workspace.ts";

/** ch.26 typed research graph node kinds. */
export const GRAPH_NODE_TYPES = [
  "hypothesis",
  "observation",
  "query",
  "model",
  "source",
  "marker",
  "agent",
] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  position?: { x: number; y: number };
  /** Query nodes (canvas panels) carry the query hash the panel renders. */
  queryRef?: string;
  data?: Record<string, unknown>;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: z.infer<typeof EvidenceRelation>;
  origin: "stored" | "derived";
}
export interface GraphUnresolved {
  id: string;
  reason: string;
  source: string;
  target: string;
  relation: string;
  missing: Array<"source" | "target">;
}
export interface GraphProjection {
  workspaceId: string;
  /** Workspace version the projection was read at. */
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Edges whose endpoint is not a persisted node. They are omitted from `edges`. */
  unresolved: GraphUnresolved[];
}

const MAX_POSITIONS = 5000;
const Coord = z.number().finite().min(-1_000_000).max(1_000_000);
export const SaveLayoutPayload = z.strictObject({
  positions: z
    .record(z.string().min(1).max(200), z.strictObject({ x: Coord, y: Coord }))
    .refine((p) => Object.keys(p).length <= MAX_POSITIONS, `at most ${MAX_POSITIONS} positions`),
});

function isMissingRelation(e: unknown): boolean {
  const c = (e as { code?: string } | null)?.code;
  return c === "42P01" || c === "3F000" || c === "42501";
}

/**
 * Evidence graph projection (C16). Nodes are projected from persisted entities (canvas panels as query nodes, markers,
 * evidence_nodes, runtime agents when readable); edges come from evidence_edges plus marker->panel references. All reads
 * run under the caller's tenant transaction, so RLS decides visibility.
 */
export class EvidenceGraphService {
  constructor(private readonly db: Db) {}

  async get(session: Session, workspaceId: string): Promise<GraphProjection> {
    return this.db.tx({ orgId: session.principal.orgId, userId: session.userId }, async (tx) => {
      const ws = (
        await tx.query<{ version: number; active_branch_id: string | null }>(
          "SELECT version, active_branch_id FROM workspaces WHERE id = $1",
          [workspaceId],
        )
      ).rows[0];
      if (!ws) throw noWorkspaceAccess();
      return this.project(tx, workspaceId, ws.version, ws.active_branch_id);
    });
  }

  private async project(
    tx: Tx,
    workspaceId: string,
    version: number,
    branchId: string | null,
  ): Promise<GraphProjection> {
    const nodes = new Map<string, GraphNode>();
    const put = (n: GraphNode) => {
      if (!nodes.has(n.id)) nodes.set(n.id, n);
    };

    const panels = await tx.query<{
      id: string;
      query_hash: string;
      kind: string;
      spec: { title?: unknown };
    }>(
      `SELECT ps.id, ps.query_hash, ps.kind, ps.spec
         FROM panel_specs ps JOIN canvas_documents d ON d.id = ps.document_id
        WHERE ps.workspace_id = $1 AND d.branch_id IS NOT DISTINCT FROM $2 AND ps.removed_at IS NULL
        ORDER BY ps.created_at, ps.id`,
      [workspaceId, branchId],
    );
    const panelLabel = new Map<string, string>();
    for (const p of panels.rows) {
      const title = typeof p.spec?.title === "string" && p.spec.title ? p.spec.title : `${p.kind} panel`;
      panelLabel.set(p.id, title);
      put({ id: p.id, type: "query", label: title, queryRef: p.query_hash, data: { panelId: p.id } });
    }

    const markers = await tx.query<{
      id: string;
      panel_id: string;
      question: string | null;
      status: string;
    }>(
      `SELECT m.id, m.panel_id, m.question, m.status FROM markers m
        JOIN panels p ON p.id = m.panel_id AND p.removed_at IS NULL
        WHERE m.workspace_id = $1 ORDER BY m.created_at, m.id`,
      [workspaceId],
    );
    const derived: GraphEdge[] = [];
    for (const m of markers.rows) {
      put({
        id: m.id,
        type: "marker",
        label: m.question ?? `Marker on ${panelLabel.get(m.panel_id) ?? "panel"}`,
        data: { panelId: m.panel_id, status: m.status },
      });
      derived.push({
        id: `derived:${m.id}:${m.panel_id}:references`,
        source: m.id,
        target: m.panel_id,
        relation: "references",
        origin: "derived",
      });
    }

    const evNodes = await tx.query<{ id: string; kind: GraphNodeType; label: string; data: object }>(
      "SELECT id, kind, label, data FROM evidence_nodes WHERE workspace_id = $1 ORDER BY created_at, id",
      [workspaceId],
    );
    for (const n of evNodes.rows) put({ id: n.id, type: n.kind, label: n.label, data: n.data as never });

    // Runtime agents (A6's schema): read-only, and absent in deployments that have not migrated it.
    try {
      await tx.query("SAVEPOINT graph_agents");
      const agents = await tx.query<{
        id: string;
        role: string;
        status: string;
        depth: number;
        run_id: string;
      }>(
        "SELECT id, role, status, depth, run_id FROM runtime.tasks WHERE workspace_id = $1 ORDER BY created_at, id",
        [workspaceId],
      );
      for (const a of agents.rows)
        put({
          id: a.id,
          type: "agent",
          label: a.role,
          data: { role: a.role, status: a.status, depth: a.depth, runId: a.run_id },
        });
      await tx.query("RELEASE SAVEPOINT graph_agents");
    } catch (e) {
      if (!isMissingRelation(e)) throw e;
      await tx.query("ROLLBACK TO SAVEPOINT graph_agents");
    }

    const stored = await tx.query<{
      id: string;
      from_node: string;
      to_node: string;
      relation: GraphEdge["relation"];
    }>(
      "SELECT id, from_node, to_node, relation FROM evidence_edges WHERE workspace_id = $1 ORDER BY created_at, id",
      [workspaceId],
    );
    const edges: GraphEdge[] = [];
    const unresolved: GraphUnresolved[] = [];
    const all: GraphEdge[] = [
      ...stored.rows.map((e) => ({
        id: e.id,
        source: e.from_node,
        target: e.to_node,
        relation: e.relation,
        origin: "stored" as const,
      })),
      ...derived,
    ];
    for (const e of all) {
      const missing: Array<"source" | "target"> = [];
      if (!nodes.has(e.source)) missing.push("source");
      if (!nodes.has(e.target)) missing.push("target");
      if (missing.length === 0) edges.push(e);
      else
        unresolved.push({
          id: e.id,
          reason: "edge references a missing node",
          source: e.source,
          target: e.target,
          relation: e.relation,
          missing,
        });
    }

    const lay = (
      await tx.query<{ positions: Record<string, { x: number; y: number }> }>(
        "SELECT positions FROM graph_layouts WHERE workspace_id = $1",
        [workspaceId],
      )
    ).rows[0];
    for (const [id, pos] of Object.entries(lay?.positions ?? {})) {
      const n = nodes.get(id);
      if (n) n.position = { x: pos.x, y: pos.y };
    }
    return { workspaceId, version, nodes: [...nodes.values()], edges, unresolved };
  }

  /** `graph.save_layout` command: replaces the workspace's node positions. */
  readonly saveLayoutHandler: CommandHandler = {
    handle: async (ctx, payload) => {
      const p = SaveLayoutPayload.safeParse(payload);
      if (!p.success)
        throw new KernelError("VALIDATION_FAILED", "INVALID_PAYLOAD", "Invalid command payload.", {
          details: zodDetails(p.error),
        });
      const count = Object.keys(p.data.positions).length;
      await ctx.tx.query(
        `INSERT INTO graph_layouts(workspace_id, org_id, positions, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (workspace_id) DO UPDATE SET positions = EXCLUDED.positions, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [ctx.workspace.id, ctx.workspace.orgId, JSON.stringify(p.data.positions), ctx.session.userId],
      );
      return {
        eventType: "workspace.updated",
        data: { change: "graph.layout_saved", nodeCount: count },
        result: { nodeCount: count },
      };
    },
  };
}
