import { randomUUID } from "node:crypto";
import { DelegationScope } from "@nearesis/contracts";
import type { Session } from "../auth.ts";
import { canAdmin } from "../auth.ts";
import type { Db } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { writeAudit } from "../journal.ts";
import { noWorkspaceAccess, zodDetails } from "../workspace.ts";

/** Delegation scopes (ch.11 "actor's delegation scope"): what a workspace member may hand to agents. Owner/admin only. */
export class DelegationService {
  constructor(private readonly db: Db) {}

  async set(s: Session, workspaceId: string, raw: unknown): Promise<void> {
    if (!canAdmin(s.role))
      throw new KernelError(
        "FORBIDDEN",
        "INSUFFICIENT_ROLE",
        "Only owners and admins grant delegation scopes.",
      );
    const r = DelegationScope.omit({ workspaceId: true }).safeParse(raw);
    if (!r.success)
      throw new KernelError("VALIDATION_FAILED", "INVALID_PAYLOAD", "Invalid delegation scope.", {
        details: zodDetails(r.error),
      });
    const p = r.data;
    await this.db.tx({ orgId: s.principal.orgId, userId: s.userId }, async (tx) => {
      if (!(await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId])).rows[0])
        throw noWorkspaceAccess();
      await tx.query(
        `INSERT INTO delegation_scopes(id, org_id, workspace_id, user_id, agents, grants, delegate_to, max_budget, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET agents = EXCLUDED.agents, grants = EXCLUDED.grants,
           delegate_to = EXCLUDED.delegate_to, max_budget = EXCLUDED.max_budget, created_by = EXCLUDED.created_by`,
        [
          randomUUID(),
          s.principal.orgId,
          workspaceId,
          p.userId,
          JSON.stringify(p.agents),
          JSON.stringify(p.grants),
          JSON.stringify(p.delegateTo),
          JSON.stringify(p.maxBudget),
          s.userId,
        ],
      );
      await writeAudit(tx, {
        orgId: s.principal.orgId,
        workspaceId,
        actorId: s.userId,
        action: "delegation.scope_set",
        subject: p.userId,
        outcome: "ok",
        detail: { agents: p.agents, grants: p.grants },
      });
    });
  }
}
