import type pg from "pg";
import { withTenant } from "./tenant.ts";

export interface AuditRecord {
  tenantId: string;
  workspaceId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  actor?: string | null;
  kind: string;
  reasonCode?: string | null;
  detail?: Record<string, unknown>;
}
export interface AuditSink {
  write(rec: AuditRecord): Promise<void>;
}

export class MemoryAudit implements AuditSink {
  readonly rows: AuditRecord[] = [];
  async write(rec: AuditRecord): Promise<void> {
    this.rows.push(rec);
  }
}

/** Audit rows live in `agent_audit` under tenant RLS. Detail must never contain secrets. */
export class PgAudit implements AuditSink {
  constructor(private readonly pool: pg.Pool) {}
  async write(r: AuditRecord): Promise<void> {
    await withTenant(this.pool, r.tenantId, (c) =>
      c.query(
        `INSERT INTO agent_audit (tenant_id, workspace_id, run_id, task_id, actor, kind, reason_code, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          r.tenantId,
          r.workspaceId ?? null,
          r.runId ?? null,
          r.taskId ?? null,
          r.actor ?? null,
          r.kind,
          r.reasonCode ?? null,
          JSON.stringify(r.detail ?? {}),
        ],
      ),
    );
  }
}
