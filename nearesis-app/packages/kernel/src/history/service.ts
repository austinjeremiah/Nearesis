import type { Session } from "../auth.ts";
import type { CanvasService } from "../canvas.ts";
import type { Db } from "../db/pool.ts";
import type { EvidenceGraphService } from "../graph.ts";
import type { EventJournal } from "../journal.ts";
import { ImpactOps } from "./impact.ts";
import { BranchOps } from "./branches.ts";
import { CollabService } from "./collab.ts";
import { GraphOps } from "./graph-ops.ts";
import { HistoryRunner } from "./runner.ts";
import { SnapshotOps } from "./snapshots.ts";
import { noWorkspaceAccess } from "../workspace.ts";
import { publicationSets } from "./claims.ts";

export interface HistoryDeps {
  db: Db;
  journal: EventJournal;
  canvas: CanvasService;
  graph: EvidenceGraphService;
}

/** Facade over evidence-graph writes, snapshots, branches, merges and Yjs collaboration. */
export class HistoryService {
  readonly runner: HistoryRunner;
  readonly graphOps: GraphOps;
  readonly snapshots: SnapshotOps;
  readonly branches: BranchOps;
  readonly collab: CollabService;
  readonly impact: ImpactOps;
  private readonly db: Db;

  constructor(deps: HistoryDeps) {
    this.db = deps.db;
    this.graph = deps.graph;
    this.runner = new HistoryRunner(deps.db, deps.journal);
    this.graphOps = new GraphOps(this.runner);
    this.snapshots = new SnapshotOps(deps.db, this.runner, deps.canvas, deps.graph);
    this.branches = new BranchOps(deps.db, this.runner);
    this.collab = new CollabService(deps.db);
    this.impact = new ImpactOps(deps.db);
  }

  private readonly graph: EvidenceGraphService;

  /** Publication eligibility and export (16b W08(e)): only supported claims may be published as supported. */
  async publicationEligibility(session: Session, workspaceId: string) {
    const g = await this.graph.get(session, workspaceId);
    const claims = g.nodes
      .filter((n) => n.type === "claim" && !n.tombstone)
      .map((n) => ({
        id: n.id,
        label: n.label,
        support: n.support,
        missing: n.missing,
        data: n.data as Record<string, unknown> | undefined,
      }));
    return { workspaceId, graphVersion: g.version, ...publicationSets(claims) };
  }

  async recheckFlags(session: Session, workspaceId: string) {
    return this.db.tx({ orgId: session.principal.orgId, userId: session.userId }, async (tx) => {
      const w = (await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
      if (!w) throw noWorkspaceAccess();
      return GraphOps.flags(tx, workspaceId);
    });
  }
}
