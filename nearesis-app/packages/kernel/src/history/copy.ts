import { randomUUID } from "node:crypto";
import type { PanelSpec } from "@nearesis/contracts";
import type { CommandBus } from "../commands.ts";
import type { Session } from "../auth.ts";
import type { Db } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { noWorkspaceAccess } from "../workspace.ts";

/**
 * Cross-workspace copy (ch.10: "cross-workspace copy yields a new item with a lineage link"). The copy is a new
 * object with its own id; the lineage row says where it came from but nothing links back to the private original.
 */
export class CopyOps {
  constructor(
    private readonly db: Db,
    private readonly commands: CommandBus,
  ) {}

  private ctx(s: Session) {
    return { orgId: s.principal.orgId, userId: s.userId, actorKind: s.principal.kind };
  }

  async copyPanel(session: Session, sourceWorkspaceId: string, panelId: string, targetWorkspaceId: string) {
    const src = await this.db.tx(this.ctx(session), async (tx) => {
      const s = (await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [sourceWorkspaceId])).rows[0];
      const t = (
        await tx.query<{ version: number; active_branch_id: string }>(
          "SELECT version, active_branch_id FROM workspaces WHERE id = $1",
          [targetWorkspaceId],
        )
      ).rows[0];
      if (!s || !t) throw noWorkspaceAccess();
      const p = (
        await tx.query<{ spec: PanelSpec }>(
          "SELECT spec FROM panel_specs WHERE id = $1 AND workspace_id = $2 AND removed_at IS NULL",
          [panelId, sourceWorkspaceId],
        )
      ).rows[0];
      if (!p) throw noWorkspaceAccess();
      const rev = (
        await tx.query<{ revision: number }>(
          "SELECT revision FROM canvas_documents WHERE workspace_id = $1 AND branch_id = $2",
          [targetWorkspaceId, t.active_branch_id],
        )
      ).rows[0]?.revision;
      return { spec: p.spec, targetVersion: t.version, targetRevision: rev ?? 0 };
    });
    const newId = randomUUID();
    const copy = { ...src.spec, panelId: newId } as PanelSpec;
    await this.commands.execute(session, targetWorkspaceId, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "canvas.apply_patch",
      expectedVersion: src.targetVersion,
      payload: {
        schemaVersion: 1,
        type: "workspace.patch",
        operationId: randomUUID(),
        expectedRevision: src.targetRevision,
        operations: [{ op: "addPanel", panel: copy }],
      },
    });
    await this.db.tx(this.ctx(session), (tx) =>
      tx.query(
        `INSERT INTO object_lineage(id, org_id, workspace_id, object_id, source_workspace_id, source_object_id, copied_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          session.principal.orgId,
          targetWorkspaceId,
          newId,
          sourceWorkspaceId,
          panelId,
          session.userId,
        ],
      ),
    );
    return { panelId: newId, lineage: { sourceWorkspaceId, sourceObjectId: panelId } };
  }

  async lineage(session: Session, workspaceId: string, objectId: string) {
    return this.db.tx(this.ctx(session), async (tx) => {
      const ws = (await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
      if (!ws) throw noWorkspaceAccess();
      const r = (
        await tx.query(
          `SELECT source_workspace_id AS "sourceWorkspaceId", source_object_id AS "sourceObjectId", copied_at AS "copiedAt"
             FROM object_lineage WHERE workspace_id = $1 AND object_id = $2`,
          [workspaceId, objectId],
        )
      ).rows[0];
      if (!r) throw new KernelError("NOT_FOUND", "NO_LINEAGE", "No lineage recorded for that object.");
      return r;
    });
  }
}
