import type pg from "pg";
import type {
  MetricProposal,
  MetricRecord,
  MetricStatus,
  MetricValidationReport,
  MetricVersionPin,
} from "@nearesis/contracts";
import { canonicalJson, sha256 } from "./registry.ts";

/** Persistence of authored metrics (additive to the static registry). Every method is scoped by tenant and workspace. */
export interface AuthoringScope {
  tenantId: string;
  workspaceId: string;
}

export interface AuditEntry {
  metricKey: string;
  version: number | null;
  action: string;
  outcome: "ok" | "refused";
  actorId: string;
  actorKind: string;
  actorRole?: string | undefined;
  detail?: Record<string, unknown>;
}

export class AuthoredStoreError extends Error {
  constructor(
    readonly reason: "IMMUTABLE_VERSION" | "ILLEGAL_TRANSITION" | "NOT_FOUND" | "CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

export const proposalHash = (p: MetricProposal): string => sha256(canonicalJson(p));

interface Row {
  tenant_id: string;
  workspace_id: string;
  metric_key: string;
  version: number;
  status: MetricStatus;
  proposal: MetricProposal;
  proposal_hash: string;
  validation: MetricValidationReport | null;
  author_id: string;
  certified_by: string | null;
  certified_at: Date | null;
  deprecated_by: string | null;
  deprecated_at: Date | null;
  deprecation_reason: string | null;
  superseded_by: number | null;
  created_at: Date;
  updated_at: Date;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const toRecord = (r: Row): MetricRecord => ({
  metricKey: r.metric_key,
  version: r.version,
  status: r.status,
  proposal: r.proposal,
  proposalHash: r.proposal_hash,
  tenantId: r.tenant_id,
  workspaceId: r.workspace_id,
  validation: r.validation,
  authorId: r.author_id,
  certifiedBy: r.certified_by,
  certifiedAt: iso(r.certified_at),
  deprecatedBy: r.deprecated_by,
  deprecatedAt: iso(r.deprecated_at),
  deprecationReason: r.deprecation_reason,
  supersededBy: r.superseded_by,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** Maps trigger errors (P0001 'REASON: ...') to typed store errors. */
function mapPgError(e: unknown): never {
  const m = /^(IMMUTABLE_VERSION|ILLEGAL_TRANSITION): (.*)$/s.exec((e as Error)?.message ?? "");
  if (m) throw new AuthoredStoreError(m[1] as "IMMUTABLE_VERSION" | "ILLEGAL_TRANSITION", m[2] as string);
  throw e;
}

const S = "analytics_meta.authored_metrics";

export class AuthoredMetricStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Allocates the next version of `key` and stores a DRAFT. `build` receives the assigned version and returns the proposal. */
  async createDraft(
    scope: AuthoringScope,
    key: string,
    author: { id: string; kind: string },
    build: (version: number) => MetricProposal,
  ): Promise<MetricRecord> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${scope.tenantId}:${scope.workspaceId}:${key}`,
      ]);
      const v = await c.query(
        `SELECT coalesce(max(version), 0) + 1 AS v FROM ${S} WHERE tenant_id = $1 AND workspace_id = $2 AND metric_key = $3`,
        [scope.tenantId, scope.workspaceId, key],
      );
      const version = Number(v.rows[0].v);
      const proposal = build(version);
      const r = await c.query(
        `INSERT INTO ${S} (tenant_id, workspace_id, metric_key, version, status, proposal, proposal_hash, author_id, author_kind, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$9) RETURNING *`,
        [
          scope.tenantId,
          scope.workspaceId,
          key,
          version,
          JSON.stringify(proposal),
          proposalHash(proposal),
          author.id,
          author.kind,
          this.clock(),
        ],
      );
      await c.query("COMMIT");
      return toRecord(r.rows[0]);
    } catch (e) {
      await c.query("ROLLBACK");
      return mapPgError(e);
    } finally {
      c.release();
    }
  }

  async get(scope: AuthoringScope, key: string, version: number): Promise<MetricRecord | null> {
    const r = await this.pool.query(
      `SELECT * FROM ${S} WHERE tenant_id = $1 AND workspace_id = $2 AND metric_key = $3 AND version = $4`,
      [scope.tenantId, scope.workspaceId, key, version],
    );
    return r.rows[0] ? toRecord(r.rows[0]) : null;
  }

  async versions(scope: AuthoringScope, key: string): Promise<MetricRecord[]> {
    const r = await this.pool.query(
      `SELECT * FROM ${S} WHERE tenant_id = $1 AND workspace_id = $2 AND metric_key = $3 ORDER BY version`,
      [scope.tenantId, scope.workspaceId, key],
    );
    return r.rows.map(toRecord);
  }

  /** The CERTIFIED version with the highest number, if any. */
  async currentCertified(scope: AuthoringScope, key: string): Promise<MetricRecord | null> {
    const r = await this.pool.query(
      `SELECT * FROM ${S} WHERE tenant_id = $1 AND workspace_id = $2 AND metric_key = $3 AND status = 'CERTIFIED'
       ORDER BY version DESC LIMIT 1`,
      [scope.tenantId, scope.workspaceId, key],
    );
    return r.rows[0] ? toRecord(r.rows[0]) : null;
  }

  /** Latest version of every metric key, optionally filtered by status. */
  async list(scope: AuthoringScope, statuses?: MetricStatus[]): Promise<MetricRecord[]> {
    const r = await this.pool.query(
      `SELECT DISTINCT ON (metric_key) * FROM ${S} WHERE tenant_id = $1 AND workspace_id = $2
       ORDER BY metric_key, version DESC`,
      [scope.tenantId, scope.workspaceId],
    );
    const all: MetricRecord[] = r.rows.map(toRecord);
    return statuses ? all.filter((x) => statuses.includes(x.status)) : all;
  }

  /** Replaces the definition of a never-certified DRAFT or VALIDATED version (status returns to DRAFT). */
  async replaceDefinition(
    scope: AuthoringScope,
    key: string,
    version: number,
    p: MetricProposal,
  ): Promise<MetricRecord> {
    try {
      const r = await this.pool.query(
        `UPDATE ${S} SET proposal = $5, proposal_hash = $6, validation = NULL, status = 'DRAFT', updated_at = $7
         WHERE tenant_id = $1 AND workspace_id = $2 AND metric_key = $3 AND version = $4 AND NOT certified_ever
           AND status IN ('DRAFT', 'VALIDATED') RETURNING *`,
        [scope.tenantId, scope.workspaceId, key, version, JSON.stringify(p), proposalHash(p), this.clock()],
      );
      if (!r.rows[0])
        throw new AuthoredStoreError("IMMUTABLE_VERSION", "Only a never-certified draft can be edited.");
      return toRecord(r.rows[0]);
    } catch (e) {
      return mapPgError(e);
    }
  }

  async saveValidation(
    scope: AuthoringScope,
    key: string,
    version: number,
    report: MetricValidationReport,
    status: "DRAFT" | "VALIDATED",
  ): Promise<MetricRecord> {
    try {
      const r = await this.pool.query(
        `UPDATE ${S} SET validation = $5, status = $6, updated_at = $7
         WHERE tenant_id = $1 AND workspace_id = $2 AND metric_key = $3 AND version = $4 AND status IN ('DRAFT', 'VALIDATED') RETURNING *`,
        [scope.tenantId, scope.workspaceId, key, version, JSON.stringify(report), status, this.clock()],
      );
      if (!r.rows[0])
        throw new AuthoredStoreError(
          "ILLEGAL_TRANSITION",
          "Only a DRAFT or VALIDATED version can be validated.",
        );
      return toRecord(r.rows[0]);
    } catch (e) {
      return mapPgError(e);
    }
  }

  async certify(scope: AuthoringScope, key: string, version: number, by: string): Promise<MetricRecord> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const now = this.clock();
      const r = await c.query(
        `UPDATE ${S} SET status = 'CERTIFIED', certified_ever = true, certified_by = $5, certified_at = $6, updated_at = $6
         WHERE tenant_id = $1 AND workspace_id = $2 AND metric_key = $3 AND version = $4 AND status = 'VALIDATED' RETURNING *`,
        [scope.tenantId, scope.workspaceId, key, version, by, now],
      );
      if (!r.rows[0])
        throw new AuthoredStoreError("ILLEGAL_TRANSITION", "Only a VALIDATED version can be certified.");
      // older certified versions stay certified and pinnable; they are marked as superseded
      await c.query(
        `UPDATE ${S} SET superseded_by = $5, updated_at = $6
         WHERE tenant_id = $1 AND workspace_id = $2 AND metric_key = $3 AND version < $4 AND status = 'CERTIFIED' AND superseded_by IS NULL`,
        [scope.tenantId, scope.workspaceId, key, version, version, now],
      );
      await c.query("COMMIT");
      return toRecord(r.rows[0]);
    } catch (e) {
      await c.query("ROLLBACK");
      return mapPgError(e);
    } finally {
      c.release();
    }
  }

  async deprecate(
    scope: AuthoringScope,
    key: string,
    version: number,
    by: string,
    reason: string,
  ): Promise<MetricRecord> {
    try {
      const now = this.clock();
      const r = await this.pool.query(
        `UPDATE ${S} SET status = 'DEPRECATED', deprecated_by = $5, deprecated_at = $6, deprecation_reason = $7, updated_at = $6
         WHERE tenant_id = $1 AND workspace_id = $2 AND metric_key = $3 AND version = $4 AND status <> 'DEPRECATED' RETURNING *`,
        [scope.tenantId, scope.workspaceId, key, version, by, now, reason],
      );
      if (!r.rows[0])
        throw new AuthoredStoreError(
          "ILLEGAL_TRANSITION",
          "The version is already deprecated or does not exist.",
        );
      return toRecord(r.rows[0]);
    } catch (e) {
      return mapPgError(e);
    }
  }

  async audit(scope: AuthoringScope, e: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO analytics_meta.authored_metric_audit (at, tenant_id, workspace_id, metric_key, version, action, outcome, actor_id, actor_kind, actor_role, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        this.clock(),
        scope.tenantId,
        scope.workspaceId,
        e.metricKey,
        e.version,
        e.action,
        e.outcome,
        e.actorId,
        e.actorKind,
        e.actorRole ?? null,
        JSON.stringify(e.detail ?? {}),
      ],
    );
  }

  async auditTrail(scope: AuthoringScope, key: string): Promise<Array<AuditEntry & { at: string }>> {
    const r = await this.pool.query(
      `SELECT at, metric_key, version, action, outcome, actor_id, actor_kind, actor_role, detail
       FROM analytics_meta.authored_metric_audit WHERE tenant_id = $1 AND workspace_id = $2 AND metric_key = $3 ORDER BY id`,
      [scope.tenantId, scope.workspaceId, key],
    );
    return r.rows.map((x) => ({
      at: (x.at as Date).toISOString(),
      metricKey: x.metric_key,
      version: x.version,
      action: x.action,
      outcome: x.outcome,
      actorId: x.actor_id,
      actorKind: x.actor_kind,
      actorRole: x.actor_role ?? undefined,
      detail: x.detail,
    }));
  }

  /** Pins exact versions to a snapshot. A snapshot's pin for a metric is written once and never changes. */
  async pin(scope: AuthoringScope, snapshotId: string, pins: MetricVersionPin[]): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      for (const p of pins)
        await c.query(
          `INSERT INTO analytics_meta.authored_metric_pins (tenant_id, workspace_id, snapshot_id, metric_key, version, proposal_hash)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, workspace_id, snapshot_id, metric_key) DO NOTHING`,
          [scope.tenantId, scope.workspaceId, snapshotId, p.metricKey, p.version, p.proposalHash],
        );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }

  async pinsOf(scope: AuthoringScope, snapshotId: string): Promise<MetricVersionPin[]> {
    const r = await this.pool.query(
      `SELECT metric_key, version, proposal_hash FROM analytics_meta.authored_metric_pins
       WHERE tenant_id = $1 AND workspace_id = $2 AND snapshot_id = $3 ORDER BY metric_key`,
      [scope.tenantId, scope.workspaceId, snapshotId],
    );
    return r.rows.map((x) => ({
      metricKey: x.metric_key,
      version: x.version,
      proposalHash: x.proposal_hash,
    }));
  }

  /** Snapshots that pin `key@version` and authored metrics that depend on it. */
  async dependentsOf(
    scope: AuthoringScope,
    key: string,
    version: number,
  ): Promise<{ snapshots: string[]; metrics: Array<{ metricKey: string; version: number }> }> {
    const s = await this.pool.query(
      `SELECT snapshot_id FROM analytics_meta.authored_metric_pins
       WHERE tenant_id = $1 AND workspace_id = $2 AND metric_key = $3 AND version = $4 ORDER BY snapshot_id`,
      [scope.tenantId, scope.workspaceId, key, version],
    );
    const m = await this.pool.query(
      `SELECT metric_key, version FROM ${S}
       WHERE tenant_id = $1 AND workspace_id = $2 AND status <> 'DEPRECATED' AND proposal->'dependencies' ? $3
       ORDER BY metric_key, version`,
      [scope.tenantId, scope.workspaceId, `${key}@${version}`],
    );
    return {
      snapshots: s.rows.map((x) => x.snapshot_id as string),
      metrics: m.rows.map((x) => ({ metricKey: x.metric_key as string, version: x.version as number })),
    };
  }

  async recordCorrections(
    scope: AuthoringScope,
    key: string,
    version: number,
    dependents: Array<{ kind: "snapshot" | "metric"; id: string }>,
    reason: string,
    actorId: string,
  ): Promise<void> {
    for (const d of dependents)
      await this.pool.query(
        `INSERT INTO analytics_meta.authored_metric_corrections (tenant_id, workspace_id, metric_key, version, dependent_kind, dependent_id, reason, actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [scope.tenantId, scope.workspaceId, key, version, d.kind, d.id, reason, actorId],
      );
  }

  async corrections(
    scope: AuthoringScope,
    key: string,
  ): Promise<Array<{ version: number; dependentKind: string; dependentId: string; reason: string }>> {
    const r = await this.pool.query(
      `SELECT version, dependent_kind, dependent_id, reason FROM analytics_meta.authored_metric_corrections
       WHERE tenant_id = $1 AND workspace_id = $2 AND metric_key = $3 ORDER BY id`,
      [scope.tenantId, scope.workspaceId, key],
    );
    return r.rows.map((x) => ({
      version: x.version,
      dependentKind: x.dependent_kind,
      dependentId: x.dependent_id,
      reason: x.reason,
    }));
  }
}
