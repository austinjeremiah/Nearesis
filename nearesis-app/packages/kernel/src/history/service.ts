import type { Session } from "../auth.ts";
import type { CanvasService } from "../canvas.ts";
import type { Db } from "../db/pool.ts";
import type { EvidenceGraphService } from "../graph.ts";
import type { EventJournal } from "../journal.ts";
import { BranchOps } from "./branches.ts";
import { CollabService } from "./collab.ts";
import { GraphOps } from "./graph-ops.ts";
import { HistoryRunner } from "./runner.ts";
import { SnapshotOps } from "./snapshots.ts";
import { noWorkspaceAccess } from "../workspace.ts";

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
  private readonly db: Db;

  constructor(deps: HistoryDeps) {
    this.db = deps.db;
    this.runner = new HistoryRunner(deps.db, deps.journal);
    this.graphOps = new GraphOps(this.runner);
    this.snapshots = new SnapshotOps(deps.db, this.runner, deps.canvas, deps.graph);
    this.branches = new BranchOps(deps.db, this.runner);
    this.collab = new CollabService(deps.db);
  }

  async recheckFlags(session: Session, workspaceId: string) {
    return this.db.tx({ orgId: session.principal.orgId, userId: session.userId }, async (tx) => {
      const w = (await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
      if (!w) throw noWorkspaceAccess();
      return GraphOps.flags(tx, workspaceId);
    });
  }
}
