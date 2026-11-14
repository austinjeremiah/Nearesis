import { randomUUID } from "node:crypto";
import { CapabilityGrant } from "@nearesis/contracts";
import type { Principal } from "@nearesis/contracts";
import { canonicalJson, grantKey, sha256Hex } from "@nearesis/plugin-sdk";
import type { Db, Tx } from "./db/pool.ts";
import { KernelError } from "./errors.ts";
import { writeAudit } from "./journal.ts";

export const MAX_LEASE_DEPTH = 3;

export interface LeaseSpec {
  grants: CapabilityGrant[];
  expiresAt: string;
}

/**
 * Child-lease derivation (K10). The child may only hold grants that exist in the parent with the same resource and
 * action, with maxCost no higher and expiry no later. Anything else is rejected outright (never silently clipped).
 */
export function deriveLease(parent: LeaseSpec, requested: LeaseSpec): LeaseSpec {
  const violations: Array<{ path: string; issue: string }> = [];
  if (requested.grants.length === 0)
    violations.push({ path: "grants", issue: "at least one grant is required" });
  if (Date.parse(requested.expiresAt) > Date.parse(parent.expiresAt)) {
    violations.push({ path: "expiresAt", issue: "lease expires later than parent" });
  }
  const byKey = new Map(parent.grants.map((g) => [grantKey(g), g]));
  requested.grants.forEach((g, i) => {
    const p = byKey.get(grantKey(g));
    if (!p) violations.push({ path: `grants.${i}`, issue: `grant ${grantKey(g)} not held by parent` });
    else {
      if (g.maxCost > p.maxCost)
        violations.push({ path: `grants.${i}.maxCost`, issue: "exceeds parent maxCost" });
      if (Date.parse(g.expiresAt) > Date.parse(p.expiresAt))
        violations.push({ path: `grants.${i}.expiresAt`, issue: "expires later than parent grant" });
    }
  });
  if (violations.length) {
    throw new KernelError(
      "FORBIDDEN",
      "LEASE_EXPANSION_DENIED",
      "Child lease must be a subset of its parent.",
      { details: violations },
    );
  }
  const seen = new Set<string>();
  const grants = requested.grants.filter((g) =>
    seen.has(grantKey(g)) ? false : (seen.add(grantKey(g)), true),
  );
  return { grants, expiresAt: requested.expiresAt };
}

export interface LeaseRow {
  id: string;
  workspaceId: string;
  holderActorId: string;
  capability: string;
  grants: CapabilityGrant[];
  expiresAt: string;
  revokedAt: string | null;
  parentLeaseId: string | null;
}

function mapLease(r: Record<string, unknown>): LeaseRow {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    holderActorId: r.holder_actor_id as string,
    capability: r.capability as string,
    grants: r.grants as CapabilityGrant[],
    expiresAt: new Date(r.expires_at as string).toISOString(),
    revokedAt: r.revoked_at ? new Date(r.revoked_at as string).toISOString() : null,
    parentLeaseId: (r.parent_lease_id as string | null) ?? null,
  };
}

export function grantFingerprint(grants: CapabilityGrant[]): string {
  return sha256Hex(canonicalJson([...grants].sort((a, b) => grantKey(a).localeCompare(grantKey(b)))));
}

export class LeaseService {
  constructor(private readonly db: Db) {}

  private ctx(p: Principal, userId: string) {
    return { orgId: p.orgId, userId, actorKind: p.kind } as const;
  }

  /** Issue a root lease. Callers must have verified the issuer's authority (admin role / supervisor). */
  async issue(
    issuer: { principal: Principal; userId: string },
    a: {
      workspaceId: string;
      holderActorId: string;
      capability: string;
      grants: unknown[];
      expiresAt: string;
    },
  ): Promise<LeaseRow> {
    const grants = a.grants.map((g) => CapabilityGrant.parse(g));
    return this.db.tx(this.ctx(issuer.principal, issuer.userId), async (tx) => {
      const ws = await tx.query("SELECT id FROM workspaces WHERE id = $1", [a.workspaceId]);
      if (!ws.rows[0]) throw new KernelError("FORBIDDEN", "ACCESS_DENIED", "Access denied.");
      const id = randomUUID();
      await tx.query(
        `INSERT INTO capability_leases(id, org_id, workspace_id, holder_actor_id, capability, grants, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          issuer.principal.orgId,
          a.workspaceId,
          a.holderActorId,
          a.capability,
          JSON.stringify(grants),
          a.expiresAt,
        ],
      );
      await writeAudit(tx, {
        orgId: issuer.principal.orgId,
        workspaceId: a.workspaceId,
        actorId: issuer.userId,
        action: "lease.issued",
        subject: id,
        outcome: "ok",
        detail: { holder: a.holderActorId, capability: a.capability },
      });
      return (await this.get(tx, id))!;
    });
  }

  async derive(
    issuer: { principal: Principal; userId: string },
    parentLeaseId: string,
    req: { holderActorId: string; capability?: string; grants: unknown[]; expiresAt: string },
  ): Promise<LeaseRow> {
    const reqGrants = req.grants.map((g) => CapabilityGrant.parse(g));
    return this.db.tx(this.ctx(issuer.principal, issuer.userId), async (tx) => {
      const parent = await this.get(tx, parentLeaseId);
      if (!parent) throw new KernelError("FORBIDDEN", "ACCESS_DENIED", "Access denied.");
      const chainOk = await this.chainValid(tx, parent);
      if (!chainOk)
        throw new KernelError("FORBIDDEN", "LEASE_INVALID", "Parent lease is expired or revoked.");
      if ((await this.depth(tx, parent)) + 1 > MAX_LEASE_DEPTH) {
        throw new KernelError("FORBIDDEN", "LEASE_DEPTH_EXCEEDED", "Maximum delegation depth exceeded.");
      }
      const capability = req.capability ?? parent.capability;
      try {
        if (capability !== parent.capability) {
          throw new KernelError(
            "FORBIDDEN",
            "LEASE_EXPANSION_DENIED",
            "Child lease must be a subset of its parent.",
            {
              details: [{ path: "capability", issue: "differs from parent capability" }],
            },
          );
        }
        const d = deriveLease(
          { grants: parent.grants, expiresAt: parent.expiresAt },
          { grants: reqGrants, expiresAt: req.expiresAt },
        );
        const id = randomUUID();
        await tx.query(
          `INSERT INTO capability_leases(id, org_id, workspace_id, holder_actor_id, capability, grants, expires_at, parent_lease_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            issuer.principal.orgId,
            parent.workspaceId,
            req.holderActorId,
            capability,
            JSON.stringify(d.grants),
            d.expiresAt,
            parent.id,
          ],
        );
        await writeAudit(tx, {
          orgId: issuer.principal.orgId,
          workspaceId: parent.workspaceId,
          actorId: issuer.userId,
          action: "lease.derived",
          subject: id,
          outcome: "ok",
          detail: { parent: parent.id },
        });
        return (await this.get(tx, id))!;
      } catch (e) {
        if (e instanceof KernelError) {
          // Persist the denial even though the derivation rolls back.
          await this.db.tx(this.ctx(issuer.principal, issuer.userId), (t2) =>
            writeAudit(t2, {
              orgId: issuer.principal.orgId,
              workspaceId: parent.workspaceId,
              actorId: issuer.userId,
              action: "lease.derive_denied",
              subject: parent.id,
              outcome: "denied",
              reasonCode: e.reasonCode,
              detail: { details: e.opts.details ?? [] },
            }),
          );
        }
        throw e;
      }
    });
  }

  async revoke(issuer: { principal: Principal; userId: string }, leaseId: string): Promise<void> {
    await this.db.tx(this.ctx(issuer.principal, issuer.userId), async (tx) => {
      await tx.query("UPDATE capability_leases SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [
        leaseId,
      ]);
    });
  }

  async get(tx: Tx, id: string): Promise<LeaseRow | undefined> {
    const r = await tx.query("SELECT * FROM capability_leases WHERE id = $1", [id]);
    return r.rows[0] ? mapLease(r.rows[0]) : undefined;
  }

  private async depth(tx: Tx, l: LeaseRow): Promise<number> {
    let d = 0;
    let cur: LeaseRow | undefined = l;
    while (cur?.parentLeaseId && d < 16) {
      cur = await this.get(tx, cur.parentLeaseId);
      d++;
    }
    return d;
  }

  /** A lease is valid only if neither it nor any ancestor is revoked or expired. */
  async chainValid(tx: Tx, l: LeaseRow, now = Date.now()): Promise<boolean> {
    let cur: LeaseRow = l;
    for (let i = 0; i < 16; i++) {
      if (cur.revokedAt || Date.parse(cur.expiresAt) <= now) return false;
      if (!cur.parentLeaseId) return true;
      const parent = await this.get(tx, cur.parentLeaseId);
      if (!parent) return false;
      cur = parent;
    }
    return false;
  }

  /** Authoritative lookup: the actor's valid leases for a capability in a workspace. */
  async validLeasesFor(
    tx: Tx,
    workspaceId: string,
    holderActorId: string,
    capability: string,
  ): Promise<LeaseRow[]> {
    const r = await tx.query(
      "SELECT * FROM capability_leases WHERE workspace_id = $1 AND holder_actor_id = $2 AND capability = $3 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC",
      [workspaceId, holderActorId, capability],
    );
    const out: LeaseRow[] = [];
    for (const row of r.rows) {
      const l = mapLease(row);
      if (await this.chainValid(tx, l)) out.push(l);
    }
    return out;
  }
}
