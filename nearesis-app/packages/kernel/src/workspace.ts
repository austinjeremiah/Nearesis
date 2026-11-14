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
import { EventJournal, writeAudit } from "./journal.ts";
import type { Tx } from "./db/pool.ts";

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

/**
 * Plugins every new workspace gets, in the same transaction as the workspace row (NEARESIS_DEFAULT_PLUGINS, comma
 * separated; default near-thesis). Without them semantic.discover@1 is CAPABILITY_NOT_AVAILABLE and every question ends
 * BLOCKED_SOURCE. A plugin with no active, usable installation is skipped (reported), never an error: a deployment that
 * has not installed it cannot enable it.
 */
export function defaultPluginSet(): string[] {
  return (process.env.NEARESIS_DEFAULT_PLUGINS ?? "near-thesis")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^[a-z][a-z0-9-]{0,63}$/.test(x));
}

/** Idempotent: enables each plugin at its active pinned major (never re-enables one an admin disabled). Returns what was enabled. */
export async function enablePluginsInTx(
  tx: Tx,
  a: {
    orgId: string;
    workspaceId: string;
    userId: string | null;
    plugins: string[];
    reason: "workspace_created" | "backfill";
  },
): Promise<{ enabled: string[]; skipped: string[] }> {
  const enabled: string[] = [];
  const skipped: string[] = [];
  for (const pluginId of [...new Set(a.plugins)]) {
    const inst = (
      await tx.query<{ version: string; major: number; state: string }>(
        "SELECT version, major, state FROM plugin_installations WHERE plugin_id = $1 AND active",
        [pluginId],
      )
    ).rows[0];
    if (!inst || inst.state === "disabled" || inst.state === "quarantined") {
      skipped.push(pluginId);
      continue;
    }
    const r = await tx.query(
      `INSERT INTO workspace_plugins(workspace_id, org_id, plugin_id, pinned_major, enabled, enabled_by)
       VALUES ($1,$2,$3,$4,true,$5) ON CONFLICT (workspace_id, plugin_id) DO NOTHING`,
      [a.workspaceId, a.orgId, pluginId, inst.major, a.userId],
    );
    if (r.rowCount) {
      enabled.push(pluginId);
      await writeAudit(tx, {
        orgId: a.orgId,
        workspaceId: a.workspaceId,
        actorId: a.userId,
        action: "plugin.enabled_by_default",
        subject: `plugin:${pluginId}`,
        outcome: "ok",
        detail: { pluginId, version: inst.version, pinnedMajor: inst.major, reason: a.reason },
      });
    }
  }
  return { enabled, skipped };
}

export class WorkspaceRegistry {
  constructor(
    private readonly db: Db,
    private readonly journal: EventJournal,
  ) {}

  async create(
    session: Session,
    raw: unknown,
    opts: { requiredPlugins?: string[] } = {},
  ): Promise<CreateWorkspaceResponse> {
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
      await enablePluginsInTx(tx, {
        orgId,
        workspaceId: wsId,
        userId: session.userId,
        plugins: [...defaultPluginSet(), ...(opts.requiredPlugins ?? [])],
        reason: "workspace_created",
      });
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
