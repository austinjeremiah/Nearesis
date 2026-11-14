import { AddReviewCommentRequest } from "@nearesis/contracts";
import type { Session } from "../auth.ts";
import type { Db } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { noWorkspaceAccess } from "../workspace.ts";
import type { CommandOpts } from "./graph-ops.ts";
import { HistoryRunner, idFor, parseBody } from "./runner.ts";

/** Reviewer comments (ch.15 P08). A comment is attributed to its author and is never evidence. */
export class ReviewOps {
  constructor(
    private readonly db: Db,
    private readonly runner: HistoryRunner,
  ) {}

  async add(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(AddReviewCommentRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "review.comment",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        const node = (
          await ctx.tx.query("SELECT 1 FROM evidence_nodes WHERE id = $1 AND workspace_id = $2", [
            p.nodeId,
            ctx.workspace.id,
          ])
        ).rows[0];
        if (!node) throw new KernelError("NOT_FOUND", "NODE_NOT_FOUND", "No such evidence node.");
        const id = idFor(ctx.commandId, "comment");
        await ctx.tx.query(
          `INSERT INTO review_comments(id, org_id, workspace_id, target_node_id, author_id, author_kind, body)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            ctx.workspace.orgId,
            ctx.workspace.id,
            p.nodeId,
            ctx.session.userId,
            ctx.session.principal.kind,
            p.body,
          ],
        );
        return {
          eventType: "claim.updated",
          data: { change: "review.comment_added", commentId: id, nodeId: p.nodeId },
          result: { commentId: id },
        };
      },
    });
  }

  async list(session: Session, workspaceId: string, nodeId?: string) {
    return this.db.tx(
      { orgId: session.principal.orgId, userId: session.userId, actorKind: session.principal.kind },
      async (tx) => {
        const ws = (await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
        if (!ws) throw noWorkspaceAccess();
        return (
          await tx.query(
            `SELECT id, target_node_id AS "nodeId", author_id AS "authorId", author_kind AS "authorKind", body,
                    created_at AS "createdAt"
               FROM review_comments WHERE workspace_id = $1 AND ($2::uuid IS NULL OR target_node_id = $2)
              ORDER BY created_at, id`,
            [workspaceId, nodeId ?? null],
          )
        ).rows;
      },
    );
  }
}
