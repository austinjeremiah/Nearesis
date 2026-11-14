import { RetentionDeleteRequest } from "@nearesis/contracts";
import type { Session } from "../auth.ts";
import type { Db } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { noWorkspaceAccess } from "../workspace.ts";
import type { CommandOpts } from "./graph-ops.ts";
import { ImpactOps } from "./impact.ts";
import { HistoryRunner, idFor, parseBody } from "./runner.ts";

/** Backup copies of a deleted payload are purged on this schedule (policy value; recorded in the queue row). */
export const BACKUP_PURGE_DAYS = 30;

/**
 * Legal-retention deletion (ch.10 "Recoverability"): the payload bytes are removed, the evidence item remains as an
 * explicit tombstone with its content hash, deletion time and reason and no excerpt, edges stay valid, and dependants
 * report `evidence_unavailable`. Every dereference checks the ACL and audits denials.
 */
export class RetentionOps {
  constructor(
    private readonly db: Db,
    private readonly runner: HistoryRunner,
  ) {}

  private ctx(s: Session) {
    return { orgId: s.principal.orgId, userId: s.userId, actorKind: s.principal.kind };
  }

  async deletePayload(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(RetentionDeleteRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "retention.delete_payload",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        const n = (
          await ctx.tx.query<{ raw_object_hash: string | null; tombstone: boolean }>(
            "SELECT raw_object_hash, tombstone FROM evidence_nodes WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
            [p.nodeId, ctx.workspace.id],
          )
        ).rows[0];
        if (!n) throw new KernelError("NOT_FOUND", "NODE_NOT_FOUND", "No such evidence item.");
        if (n.tombstone || !n.raw_object_hash)
          throw new KernelError("DOMAIN_INVARIANT", "NOTHING_TO_DELETE", "The item holds no payload.");
        const hash = n.raw_object_hash;
        // Deduplicated bytes referenced by another item cannot be deleted from under it.
        const others = (
          await ctx.tx.query(
            "SELECT 1 FROM evidence_nodes WHERE org_id = $1 AND raw_object_hash = $2 AND id <> $3 LIMIT 1",
            [ctx.workspace.orgId, hash, p.nodeId],
          )
        ).rows[0];
        if (others)
          throw new KernelError(
            "DOMAIN_INVARIANT",
            "RAW_OBJECT_SHARED",
            "Another evidence item references the same bytes; delete that item's payload too.",
          );
        await ctx.tx.query("DELETE FROM raw_objects WHERE org_id = $1 AND hash = $2", [
          ctx.workspace.orgId,
          hash,
        ]);
        await ctx.tx.query(
          `UPDATE evidence_nodes SET tombstone = true, tombstone_reason = $3, content_hash = $4, deleted_at = now(),
                  raw_object_hash = NULL, data = '{}'::jsonb, label = $5
            WHERE id = $1 AND workspace_id = $2`,
          [p.nodeId, ctx.workspace.id, p.reason, hash, `TOMBSTONE ${p.nodeId.slice(0, 8)}`],
        );
        await ctx.tx.query(
          `INSERT INTO retention_queue(id, org_id, workspace_id, content_hash, action, reason, due_at)
           VALUES ($1,$2,$3,$4,'purge_backups',$5, now() + ($6 || ' days')::interval)`,
          [
            idFor(ctx.commandId, "retention"),
            ctx.workspace.orgId,
            ctx.workspace.id,
            hash,
            p.reason,
            String(BACKUP_PURGE_DAYS),
          ],
        );
        return {
          eventType: "evidence.verified",
          data: {
            change: "retention.payload_deleted",
            nodeId: p.nodeId,
            contentHash: hash,
            reason: p.reason,
          },
          result: { nodeId: p.nodeId, contentHash: hash },
        };
      },
    });
  }

  /**
   * Dereference an evidence item the way an agent or a user tool does. Tombstones return metadata only. Items of
   * another workspace and items the caller has no grant for answer exactly like a missing item, and are audited.
   */
  async dereference(session: Session, workspaceId: string, nodeId: string) {
    try {
      return await this.db.tx(this.ctx(session), async (tx) => {
        const ws = (await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
        if (!ws) throw noWorkspaceAccess();
        const n = (
          await tx.query<{
            id: string;
            kind: string;
            label: string;
            data: Record<string, unknown>;
            tombstone: boolean;
            tombstone_reason: string | null;
            content_hash: string | null;
            deleted_at: Date | null;
            raw_object_hash: string | null;
            public_asset_id: string | null;
          }>(
            `SELECT id, kind, label, data, tombstone, tombstone_reason, content_hash, deleted_at, raw_object_hash, public_asset_id
               FROM evidence_nodes WHERE id = $1 AND workspace_id = $2`,
            [nodeId, workspaceId],
          )
        ).rows[0];
        if (!n) throw noWorkspaceAccess();
        if ((await ImpactOps.hiddenFor(tx, workspaceId, session.userId)).has(nodeId))
          throw noWorkspaceAccess();
        if (n.tombstone)
          return {
            nodeId: n.id,
            tombstone: true as const,
            kind: n.kind,
            contentHash: n.content_hash,
            deletedAt: n.deleted_at ? new Date(n.deleted_at).toISOString() : null,
            reason: n.tombstone_reason,
          };
        if (n.public_asset_id) {
          const a = (
            await tx.query("SELECT id, content_hash, title FROM public_assets WHERE id = $1", [
              n.public_asset_id,
            ])
          ).rows[0];
          return {
            nodeId: n.id,
            tombstone: false as const,
            publicAsset: { id: a.id, contentHash: a.content_hash, title: a.title },
          };
        }
        return {
          nodeId: n.id,
          tombstone: false as const,
          kind: n.kind,
          label: n.label,
          data: n.data,
          rawObjectHash: n.raw_object_hash,
        };
      });
    } catch (e) {
      if (e instanceof KernelError && e.reasonCode === "ACCESS_DENIED") {
        await this.db.tx(this.ctx(session), (tx) =>
          tx.query(
            `INSERT INTO audit_events(id, org_id, workspace_id, actor_id, action, subject, outcome, reason_code, detail)
             VALUES (gen_random_uuid(), $1, NULL, $2, 'evidence.dereference_denied', $3, 'denied', 'ACCESS_DENIED', $4)`,
            [
              session.principal.orgId,
              session.userId,
              nodeId,
              JSON.stringify({ actorKind: session.principal.kind, requestedWorkspace: workspaceId }),
            ],
          ),
        );
      }
      throw e;
    }
  }

  async queue(session: Session, workspaceId: string) {
    return this.db.tx(this.ctx(session), async (tx) => {
      const ws = (await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
      if (!ws) throw noWorkspaceAccess();
      return (
        await tx.query(
          `SELECT content_hash AS "contentHash", action, reason, due_at AS "dueAt" FROM retention_queue
            WHERE workspace_id = $1 ORDER BY created_at`,
          [workspaceId],
        )
      ).rows;
    });
  }
}
