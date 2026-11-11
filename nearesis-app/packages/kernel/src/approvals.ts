import { randomUUID } from "node:crypto";
import type { Tx } from "./db/pool.ts";
import { KernelError } from "./errors.ts";

/**
 * Same derivation as @nearesis/agent-runtime `taskIdFromHash`: the runtime makes the approved action hash the
 * idempotency identity of the patch it applies (`operationId`). Keep the two byte-identical.
 */
export function operationIdFromActionHash(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const DEFAULT_APPROVAL_TTL_MS = 24 * 3600_000;

/**
 * Approval records the kernel itself verifies (ch.05). A record is created when an authorised human approves an exact
 * action hash (the approvals API) and is consumed exactly once, in the same transaction as the privileged mutation.
 * Denials throw APPROVAL_REQUIRED with a precise reason; they write nothing, so the caller's transaction leaves no mutation.
 */
export class ApprovalService {
  /** Record (or refresh, while unused) an approval of `actionHash` for a run in a workspace. */
  async grant(
    tx: Tx,
    a: {
      orgId: string;
      workspaceId: string;
      runId: string;
      actionHash: string;
      approvedBy: string;
      ttlMs?: number;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO command_approvals(id, org_id, workspace_id, run_id, action_hash, approved_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' milliseconds')::interval)
       ON CONFLICT (workspace_id, run_id, action_hash) DO UPDATE
         SET expires_at = EXCLUDED.expires_at, approved_by = EXCLUDED.approved_by
         WHERE command_approvals.used_at IS NULL`,
      [
        randomUUID(),
        a.orgId,
        a.workspaceId,
        a.runId,
        a.actionHash,
        a.approvedBy,
        String(a.ttlMs ?? DEFAULT_APPROVAL_TTL_MS),
      ],
    );
  }

  /** Revoke unused approvals of a run (all, or one action hash); effective on the next consume. Returns the count. */
  async revoke(tx: Tx, a: { workspaceId: string; runId: string; actionHash?: string }): Promise<number> {
    const r = await tx.query(
      `UPDATE command_approvals SET revoked_at = now()
        WHERE workspace_id = $1 AND run_id = $2 AND used_at IS NULL AND revoked_at IS NULL
          AND ($3::text IS NULL OR action_hash = $3)`,
      [a.workspaceId, a.runId, a.actionHash ?? null],
    );
    return r.rowCount ?? 0;
  }

  /**
   * Find the approval of this run whose hash `matches` the exact action, verify it is unexpired and unused, and mark it
   * used. Rows are locked, so two concurrent executions cannot both consume it.
   */
  async consume(
    tx: Tx,
    a: {
      workspaceId: string;
      runId: string | undefined;
      usedBy: string;
      matches: (actionHash: string) => boolean;
    },
  ): Promise<{ approvalId: string; actionHash: string }> {
    const deny = (reason: string, message: string): never => {
      throw new KernelError("APPROVAL_REQUIRED", reason, message, {
        nextAction: "Obtain an approval for this exact action and retry.",
      });
    };
    if (!a.runId) return deny("APPROVAL_MISSING", "A privileged action by an agent needs an approved run.");
    const rows = (
      await tx.query<{ id: string; action_hash: string; live: boolean; used: boolean; revoked: boolean }>(
        `SELECT id, action_hash, (expires_at > now()) AS live, (used_at IS NOT NULL) AS used, (revoked_at IS NOT NULL) AS revoked
           FROM command_approvals WHERE workspace_id = $1 AND run_id = $2 FOR UPDATE`,
        [a.workspaceId, a.runId],
      )
    ).rows;
    if (rows.length === 0) return deny("APPROVAL_MISSING", "No approval exists for this run.");
    const hit = rows.filter((r) => a.matches(r.action_hash));
    if (hit.length === 0)
      return deny("APPROVAL_HASH_MISMATCH", "The action does not match any approved action hash.");
    const usable = hit.find((r) => !r.used && r.live && !r.revoked);
    if (!usable) {
      if (hit.some((r) => r.revoked && !r.used))
        return deny("APPROVAL_REVOKED", "This approval was revoked.");
      if (hit.some((r) => r.used)) return deny("APPROVAL_REUSED", "This approval was already used.");
      return deny("APPROVAL_EXPIRED", "This approval has expired.");
    }
    const upd = await tx.query(
      "UPDATE command_approvals SET used_at = now(), used_by = $2 WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()",
      [usable.id, a.usedBy],
    );
    if (upd.rowCount !== 1) return deny("APPROVAL_REUSED", "This approval was already used.");
    return { approvalId: usable.id, actionHash: usable.action_hash };
  }
}
