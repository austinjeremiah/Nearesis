import { createHash, randomUUID } from "node:crypto";
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

/** Hash of part `index` of an approved action: the identity of one derived approval (see `delegateParts`). */
export const partActionHash = (actionHash: string, index: number): string =>
  createHash("sha256").update(`${actionHash}:${index}`).digest("hex");
/** Operation id a command must carry to consume part `index` of the approved action (same derivation as the runtime's). */
export const partOperationId = (actionHash: string, index: number): string =>
  operationIdFromActionHash(partActionHash(actionHash, index));

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
      /** When set, the approver must hold one of these roles in the org at consume time (e.g. ["owner"] for chain writes). */
      approverRoles?: readonly string[];
    },
  ): Promise<{ approvalId: string; actionHash: string }> {
    const deny = (reason: string, message: string): never => {
      throw new KernelError("APPROVAL_REQUIRED", reason, message, {
        nextAction: "Obtain an approval for this exact action and retry.",
      });
    };
    if (!a.runId) return deny("APPROVAL_MISSING", "A privileged action by an agent needs an approved run.");
    const rows = (
      await tx.query<{
        id: string;
        action_hash: string;
        live: boolean;
        used: boolean;
        revoked: boolean;
        approver_role: string | null;
      }>(
        `SELECT c.id, c.action_hash, (c.expires_at > now()) AS live, (c.used_at IS NOT NULL) AS used,
                (c.revoked_at IS NOT NULL) AS revoked,
                (SELECT m.role FROM memberships m WHERE m.org_id = c.org_id AND m.user_id = c.approved_by) AS approver_role
           FROM command_approvals c WHERE c.workspace_id = $1 AND c.run_id = $2 FOR UPDATE OF c`,
        [a.workspaceId, a.runId],
      )
    ).rows;
    if (rows.length === 0) return deny("APPROVAL_MISSING", "No approval exists for this run.");
    const hit = rows.filter((r) => a.matches(r.action_hash));
    if (hit.length === 0)
      return deny("APPROVAL_HASH_MISMATCH", "The action does not match any approved action hash.");
    const roleOk = (r: { approver_role: string | null }) =>
      !a.approverRoles || (r.approver_role !== null && a.approverRoles.includes(r.approver_role));
    const usable = hit.find((r) => !r.used && r.live && !r.revoked && roleOk(r));
    if (!usable) {
      if (hit.some((r) => !r.used && r.live && !r.revoked && !roleOk(r)))
        return deny("APPROVAL_NOT_OWNER", "This approval was not issued by an owner.");
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

  /**
   * Splits ONE approved action into `parts` single-use derived approvals, so an approved patch can be applied as several
   * commands (progressive composition, PERF06) without weakening exactly-once consumption. The parent approval (an existing,
   * unused, unexpired, unrevoked approval of `actionHash` for this run) is consumed here, atomically with the creation of
   * the children; each child carries the parent's approver, expiry and revocability and authorises exactly the command whose
   * `operationId` is `partOperationId(actionHash, i)`, once. Idempotent: when the children already exist (a retried
   * execution) nothing is consumed again and the same operation ids are returned, so execution resumes where it stopped.
   */
  async delegateParts(
    tx: Tx,
    a: {
      workspaceId: string;
      runId: string | undefined;
      actionHash: string;
      parts: number;
      usedBy: string;
      approverRoles?: readonly string[];
    },
  ): Promise<string[]> {
    const ids = Array.from({ length: a.parts }, (_, i) => partOperationId(a.actionHash, i));
    if (!a.runId)
      throw new KernelError("APPROVAL_REQUIRED", "APPROVAL_MISSING", "An approved run is required.");
    const existing = await tx.query(
      "SELECT 1 FROM command_approvals WHERE workspace_id = $1 AND run_id = $2 AND action_hash = $3",
      [a.workspaceId, a.runId, partActionHash(a.actionHash, 0)],
    );
    if (existing.rowCount === 1) return ids;
    const consumed = await this.consume(tx, {
      workspaceId: a.workspaceId,
      runId: a.runId,
      usedBy: a.usedBy,
      matches: (h) => h === a.actionHash,
      ...(a.approverRoles ? { approverRoles: a.approverRoles } : {}),
    });
    await tx.query(
      `INSERT INTO command_approvals(id, org_id, workspace_id, run_id, action_hash, approved_by, expires_at)
       SELECT gen_random_uuid(), p.org_id, p.workspace_id, p.run_id, h.hash, p.approved_by, p.expires_at
         FROM command_approvals p, unnest($2::text[]) AS h(hash)
        WHERE p.id = $1
       ON CONFLICT (workspace_id, run_id, action_hash) DO NOTHING`,
      [consumed.approvalId, ids.map((_, i) => partActionHash(a.actionHash, i))],
    );
    return ids;
  }
}
