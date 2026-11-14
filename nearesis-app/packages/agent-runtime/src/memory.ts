import { randomUUID } from "node:crypto";
import type pg from "pg";

export interface MemoryNs {
  tenantId: string;
  workspaceId: string;
  role: string;
}
export interface MemoryItem {
  id: string;
  content: string;
  tier: "episodic" | "semantic";
  scope: "role" | "workspace";
  evidenceRef: string;
  evidenceStatus: "resolved" | "evidence_unresolved";
  /** false when the evidence cannot be resolved: the claim must not be cited as a source (ch.10). */
  citable: boolean;
}

export class MemoryNotFound extends Error {
  constructor() {
    super("memory not found");
    this.name = "MemoryNotFound";
  }
}

async function scoped<T>(
  pool: pg.Pool,
  ns: { tenantId: string; workspaceId: string },
  fn: (c: pg.PoolClient) => Promise<T>,
) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.org_id', $1, true), set_config('app.workspace_id', $2, true)", [
      ns.tenantId,
      ns.workspaceId,
    ]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Workspace-scoped agent memory (A17). Namespace = (tenantId, workspaceId, agentRole, scope), enforced twice:
 * in every query predicate and by RLS (app.org_id + app.workspace_id). Every item carries an evidence reference;
 * items whose evidence is missing or tombstoned are returned flagged `evidence_unresolved` and not citable.
 */
export class MemoryStore {
  constructor(private readonly pool: pg.Pool) {}

  async store(
    ns: MemoryNs,
    m: { scope: "role" | "workspace"; tier: "episodic" | "semantic"; content: string; evidenceId: string },
  ): Promise<string> {
    if (!m.evidenceId) throw new Error("memory requires an evidence reference");
    const id = randomUUID();
    await scoped(this.pool, ns, (c) =>
      c.query(
        `INSERT INTO agent_memory (id, tenant_id, workspace_id, agent_role, scope, tier, content, evidence_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, ns.tenantId, ns.workspaceId, ns.role, m.scope, m.tier, m.content, m.evidenceId],
      ),
    );
    return id;
  }

  private select = `SELECT m.id, m.content, m.tier, m.scope, m.evidence_id,
            (e.evidence_id IS NOT NULL AND NOT e.tombstoned) AS resolved
     FROM agent_memory m
     LEFT JOIN agent_evidence_refs e ON e.workspace_id = m.workspace_id AND e.evidence_id = m.evidence_id`;

  private shape(r: {
    id: string;
    content: string;
    tier: "episodic" | "semantic";
    scope: "role" | "workspace";
    evidence_id: string;
    resolved: boolean;
  }): MemoryItem {
    return {
      id: r.id,
      content: r.content,
      tier: r.tier,
      scope: r.scope,
      evidenceRef: r.evidence_id,
      evidenceStatus: r.resolved ? "resolved" : "evidence_unresolved",
      citable: r.resolved,
    };
  }

  /** Substring recall (parameterised). Vector retrieval is out of scope for P04. */
  async recall(ns: MemoryNs, query: string, limit = 20): Promise<MemoryItem[]> {
    const rows = await scoped(this.pool, ns, async (c) => {
      const r = await c.query(
        `${this.select}
         WHERE m.tenant_id=$1 AND m.workspace_id=$2 AND (m.scope='workspace' OR m.agent_role=$3)
           AND m.content ILIKE '%' || $4 || '%'
         ORDER BY m.created_at, m.id LIMIT $5`,
        [ns.tenantId, ns.workspaceId, ns.role, query.replace(/[%_\\]/g, "\\$&"), limit],
      );
      return r.rows;
    });
    return rows.map((r) => this.shape(r));
  }

  /** Direct ID fetch: absent, foreign-tenant, foreign-workspace and other-role-scoped all yield the same error. */
  async get(ns: MemoryNs, id: string): Promise<MemoryItem> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new MemoryNotFound();
    const rows = await scoped(this.pool, ns, async (c) => {
      const r = await c.query(
        `${this.select} WHERE m.id=$1 AND m.tenant_id=$2 AND m.workspace_id=$3 AND (m.scope='workspace' OR m.agent_role=$4)`,
        [id, ns.tenantId, ns.workspaceId, ns.role],
      );
      return r.rows;
    });
    if (!rows[0]) throw new MemoryNotFound();
    return this.shape(rows[0]);
  }
}
