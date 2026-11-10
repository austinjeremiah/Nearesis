import { randomUUID } from "node:crypto";
import {
  CreateWorkspaceRequest,
  CreateWorkspaceResponse as CreateWorkspaceResponseSchema,
} from "@nearesis/contracts";
import type { Workspace } from "@nearesis/contracts";
import type { z } from "zod";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import { canWrite } from "./auth.ts";
import type { Session } from "./auth.ts";
import type { Db } from "./db/pool.ts";
import { KernelError } from "./errors.ts";
import { EventJournal } from "./journal.ts";

export type CreateWorkspaceResponse = z.infer<typeof CreateWorkspaceResponseSchema>;

export function zodDetails(err: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return err.issues.slice(0, 100).map((i) => ({ path: i.path.map(String).join("."), issue: i.message }));
}

/**
 * Existence-leak policy: a workspace the caller cannot see (other tenant) and one that does not exist produce the SAME
 * error (same status, reasonCode and message). RLS makes the foreign row invisible, so the code cannot tell them apart.
 */
export const noWorkspaceAccess = (): KernelError =>
  new KernelError("FORBIDDEN", "ACCESS_DENIED", "Access denied.");
export const workspaceNotFound = (): KernelError => new KernelError("NOT_FOUND", "NOT_FOUND", "Not found.");

export class WorkspaceRegistry {
  constructor(
    private readonly db: Db,
    private readonly journal: EventJournal,
  ) {}

  async create(session: Session, raw: unknown): Promise<CreateWorkspaceResponse> {
    const parsed = CreateWorkspaceRequest.safeParse(raw);
    if (!parsed.success) {
      throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request body.", {
        details: zodDetails(parsed.error),
      });
    }
    if (!canWrite(session.role))
      throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role cannot create workspaces.");
    const req = parsed.data;
    const orgId = session.principal.orgId;
    const payloadHash = sha256Hex(canonicalJson({ o: req.objective, n: req.networkScope }));
    return this.db.tx({ orgId, userId: session.userId }, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `create:${orgId}:${req.idempotencyKey}`,
      ]);
      const prior = await tx.query<{ workspace_id: string; version: number; payload_hash: string }>(
        "SELECT workspace_id, version, payload_hash FROM create_requests WHERE org_id = $1 AND idempotency_key = $2",
        [orgId, req.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].payload_hash !== payloadHash) {
          throw new KernelError(
            "DOMAIN_INVARIANT",
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency key reused with a different body.",
          );
        }
        return { workspaceId: prior.rows[0].workspace_id, version: prior.rows[0].version };
      }
      const wsId = randomUUID();
      const branchId = randomUUID();
      await tx.query(
        `INSERT INTO workspaces(id, org_id, objective, network_scope, active_branch_id, version, created_by)
         VALUES ($1,$2,$3,$4,$5,1,$6)`,
        [wsId, orgId, req.objective, req.networkScope, branchId, session.userId],
      );
      await tx.query("INSERT INTO branches(id, org_id, workspace_id, created_by) VALUES ($1,$2,$3,$4)", [
        branchId,
        orgId,
        wsId,
        session.userId,
      ]);
      await this.journal.append(tx, {
        orgId,
        workspaceId: wsId,
        type: "workspace.created",
        actorId: session.userId,
        data: { objective: req.objective, networkScope: req.networkScope },
        causationId: req.idempotencyKey,
      });
      await tx.query(
        "INSERT INTO create_requests(org_id, idempotency_key, actor_id, workspace_id, payload_hash, version) VALUES ($1,$2,$3,$4,$5,1)",
        [orgId, req.idempotencyKey, session.userId, wsId, payloadHash],
      );
      return { workspaceId: wsId, version: 1 };
    });
  }

  /** Member projection. Non-members and unknown ids are indistinguishable (404). */
  async get(session: Session, workspaceId: string): Promise<Workspace> {
    const row = await this.db.tx({ orgId: session.principal.orgId, userId: session.userId }, async (tx) => {
      const r = await tx.query("SELECT * FROM workspaces WHERE id = $1", [workspaceId]);
      return r.rows[0];
    });
    if (!row) throw workspaceNotFound();
    return {
      id: row.id,
      orgId: row.org_id,
      objective: row.objective,
      networkScope: row.network_scope,
      activeBranchId: row.active_branch_id,
      version: row.version,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at).toISOString(),
      archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    };
  }
}
