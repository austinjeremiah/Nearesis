/**
 * Bridges the agent runtime to the real kernel: capability leases through the kernel lease API (K10 derivation) and the
 * approved canvas change through the kernel command bus (`canvas.apply_patch`). Nothing here widens authority: a child
 * lease is a derived subset, and the canvas command is applied under the requesting human's role and membership.
 */
import { randomUUID } from "node:crypto";
import type { CanvasPatch, Principal } from "@nearesis/contracts";
import type { Kernel, Session } from "@nearesis/kernel";
import type pg from "pg";
import { grantFor } from "./grants.ts";
import { withTenant } from "./tenant.ts";
import type { LeaseBroker, LeaseRequest, Requester } from "./leases.ts";

export interface Issuer {
  principal: Principal;
  userId: string;
}
/** Resolves the human on whose behalf leases are issued and commands applied. */
export type RequesterResolver = (tenantId: string, runId: string) => Promise<Requester | null>;

/** Resolves the requesting human of a run from the runtime schema (`runs.requested_by`). */
export function requesterFromRuns(pool: pg.Pool): RequesterResolver {
  return async (tenantId, runId) =>
    withTenant(pool, tenantId, async (c) => {
      const r = await c.query<{ requested_by: string | null; requested_role: Requester["role"] | null }>(
        "SELECT requested_by, requested_role FROM runs WHERE id=$1",
        [runId],
      );
      const row = r.rows[0];
      return row?.requested_by && row.requested_role
        ? { userId: row.requested_by, role: row.requested_role }
        : null;
    });
}

export interface KernelLeaseBrokerOpts {
  kernel: Kernel;
  requesterOf: RequesterResolver;
  /** lease lifetime; the root lease bounds every derived lease */
  ttlMs?: number;
  maxCost?: number;
}

export class KernelLeaseBroker implements LeaseBroker {
  constructor(private readonly o: KernelLeaseBrokerOpts) {}

  private async issuer(tenantId: string, runId: string): Promise<Issuer> {
    const r = await this.o.requesterOf(tenantId, runId);
    if (!r) throw new Error("run has no requesting user; leases cannot be issued");
    return {
      principal: { kind: "human", actorId: r.userId, orgId: tenantId } as Principal,
      userId: r.userId,
    };
  }

  private async held(tenantId: string, workspaceId: string, holder: string, capability: string) {
    const k = this.o.kernel;
    return k.db.tx({ orgId: tenantId, userId: holder, actorKind: "agent" }, (tx) =>
      k.leases.validLeasesFor(tx, workspaceId, holder, capability),
    );
  }

  async ensureRoot(a: LeaseRequest): Promise<void> {
    const issuer = await this.issuer(a.tenantId, a.runId);
    const expiresAt = new Date(Date.now() + (this.o.ttlMs ?? 2 * 3_600_000)).toISOString();
    for (const capability of new Set(a.capabilities)) {
      if ((await this.held(a.tenantId, a.workspaceId, a.taskId, capability)).length) continue;
      const g = grantFor(capability);
      await this.o.kernel.leases.issue(issuer, {
        workspaceId: a.workspaceId,
        holderActorId: a.taskId,
        capability,
        grants: [{ ...g, maxCost: this.o.maxCost ?? 1000, expiresAt }],
        expiresAt,
      });
    }
  }

  async ensureChild(a: LeaseRequest & { parentTaskId: string }): Promise<void> {
    const issuer = await this.issuer(a.tenantId, a.runId);
    for (const capability of new Set(a.capabilities)) {
      if ((await this.held(a.tenantId, a.workspaceId, a.taskId, capability)).length) continue;
      const parents = await this.held(a.tenantId, a.workspaceId, a.parentTaskId, capability);
      const parent = parents[0];
      if (!parent) continue; // the parent lacks it: the child cannot be granted it (no expansion)
      await this.o.kernel.leases.derive(issuer, parent.id, {
        holderActorId: a.taskId,
        grants: parent.grants,
        expiresAt: parent.expiresAt,
      });
    }
  }

  async revokeTask(a: {
    tenantId: string;
    workspaceId: string;
    runId: string;
    taskId: string;
  }): Promise<number> {
    const k = this.o.kernel;
    const rows = await k.db.tx({ orgId: a.tenantId, userId: a.taskId, actorKind: "agent" }, async (tx) => {
      const r = await tx.query(
        "SELECT id FROM capability_leases WHERE workspace_id = $1 AND holder_actor_id = $2 AND revoked_at IS NULL",
        [a.workspaceId, a.taskId],
      );
      return r.rows as Array<{ id: string }>;
    });
    const issuer = await this.issuer(a.tenantId, a.runId);
    for (const r of rows) await k.leases.revoke(issuer, r.id);
    return rows.length;
  }

  async hasGrant(a: {
    tenantId: string;
    workspaceId: string;
    taskId: string;
    capability: string;
  }): Promise<boolean> {
    return (await this.held(a.tenantId, a.workspaceId, a.taskId, a.capability)).length > 0;
  }
}

/** Applies an approved canvas patch through the kernel command bus (`canvas.apply_patch`). */
export class KernelCanvasExecutor {
  constructor(private readonly kernel: Kernel) {}

  /** Agent principal acting for the requesting human: membership and role come from the human, identity from the agent. */
  sessionFor(a: { tenantId: string; runId: string; agentActorId: string; requester: Requester }): Session {
    return {
      principal: { kind: "agent", actorId: a.agentActorId, orgId: a.tenantId, parentRunId: a.runId },
      role: a.requester.role,
      userId: a.requester.userId,
    } as Session;
  }

  async documentRevision(session: Session, workspaceId: string): Promise<number> {
    return (await this.kernel.canvas.get(session, workspaceId)).documentRevision;
  }

  async apply(
    session: Session,
    workspaceId: string,
    patch: CanvasPatch,
  ): Promise<{ workspaceVersion: number; eventSeq: number }> {
    const ws = await this.kernel.workspaces.get(session, workspaceId);
    const r = await this.kernel.commands.execute(session, workspaceId, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "canvas.apply_patch",
      payload: patch,
      expectedVersion: ws.version,
    });
    return { workspaceVersion: r.workspaceVersion, eventSeq: r.eventSeq };
  }
}
