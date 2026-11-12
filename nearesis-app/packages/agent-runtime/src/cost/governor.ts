import type pg from "pg";
import { AgentRuntimeError } from "../errors.ts";
import { withTenant } from "../tenant.ts";
import type { AuditSink } from "../audit.ts";
import { emitAlert } from "./alerts.ts";
import { COST_UNITS, isCostDimension } from "./dimensions.ts";
import type { CostDimension } from "./dimensions.ts";
import { effectivePeriod, readPolicy } from "./policy.ts";
import type { AlertSink, CostPolicy } from "./types.ts";

export type CostBlockReason = "CAP_REACHED" | "DIMENSION_LIMIT" | "PAID_OP_NOT_PERMITTED" | "HARD_STOPPED";

/** A spend refused BEFORE execution. Maps to BUDGET_EXCEEDED so workflows treat it as a human-resolution stop. */
export class CostBlockedError extends AgentRuntimeError {
  constructor(
    readonly costReason: CostBlockReason,
    message: string,
    detail: Record<string, unknown>,
  ) {
    super("BUDGET_EXCEEDED", message, { costReason, ...detail });
    this.name = "CostBlockedError";
  }
}

export interface SpendRequest {
  tenantId: string;
  workspaceId: string;
  runId?: string | null;
  /** Idempotency key: a repeated authorize of the same key returns the first reservation. */
  key: string;
  dimension: CostDimension;
  quantity: number;
  /** Estimated USD; defaults to quantity x the policy rate for the dimension. */
  usd?: number;
  /** Set for operations that cost money at an external provider; must be listed in the policy's paidOpsPermitted. */
  paidOp?: string;
  detail?: Record<string, unknown>;
}
export interface Reservation {
  key: string;
  usd: number;
  state: "reserved" | "settled" | "released";
  /** true when the key already existed (replay). */
  replay: boolean;
}

export interface GovernorOptions {
  pool: pg.Pool;
  audit?: AuditSink;
  sink?: AlertSink;
  clock?: () => Date;
}

const EPS = 1e-12;

/**
 * Spend governor (ch.13 cost model, PERF12). Every metered spend is AUTHORISED before execution against the
 * workspace policy (cap, per-dimension limit, paid-operation permission) with the estimated cost reserved in the same
 * transaction, then SETTLED with the actual quantity. A refused spend writes a block row and an audit record and
 * never reaches the provider. Reaching the cap also sets a sticky hard stop (cleared only by `resumeWorkspace`).
 * A workspace without a policy is metered but not capped.
 */
export class CostGovernor {
  private readonly pool: pg.Pool;
  private readonly clock: () => Date;
  constructor(private readonly o: GovernorOptions) {
    this.pool = o.pool;
    this.clock = o.clock ?? (() => new Date());
  }

  async authorize(r: SpendRequest): Promise<Reservation> {
    if (!isCostDimension(r.dimension)) throw new Error(`unknown cost dimension ${r.dimension}`);
    if (!Number.isFinite(r.quantity) || r.quantity < 0)
      throw new Error("quantity must be a finite number >= 0");
    const now = this.clock();
    type Outcome =
      | { ok: true; res: Reservation; policy: CostPolicy | null; before: number; after: number }
      | { ok: false; reason: CostBlockReason; detail: Record<string, unknown>; policy: CostPolicy };
    const out = await withTenant(this.pool, r.tenantId, async (c): Promise<Outcome> => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cost:${r.tenantId}:${r.workspaceId}`]);
      const prior = await c.query("SELECT usd, state FROM runtime.cost_ledger WHERE entry_key=$1", [r.key]);
      if (prior.rows[0])
        return {
          ok: true,
          res: { key: r.key, usd: Number(prior.rows[0].usd), state: prior.rows[0].state, replay: true },
          policy: null,
          before: 0,
          after: 0,
        };
      const policy = await readPolicy(c, r.tenantId, r.workspaceId, true);
      const usd = r.usd ?? r.quantity * (policy?.rates[r.dimension] ?? 0);
      if (!policy) {
        await this.insert(c, r, usd, now);
        return {
          ok: true,
          res: { key: r.key, usd, state: "reserved", replay: false },
          policy: null,
          before: 0,
          after: 0,
        };
      }
      const per = effectivePeriod(policy, now);
      const t = await c.query(
        `SELECT COALESCE(SUM(usd),0)::float8 AS usd,
                COALESCE(SUM(quantity) FILTER (WHERE dimension=$4),0)::float8 AS q
           FROM runtime.cost_ledger
          WHERE tenant_id=$1 AND workspace_id=$2 AND state IN ('reserved','settled') AND created_at >= $3`,
        [r.tenantId, r.workspaceId, per.start.toISOString(), r.dimension],
      );
      const ledgerUsd = t.rows[0].usd as number;
      const dimQty = t.rows[0].q as number;
      const base = { ledgerUsd, capUsd: policy.capUsd, requestedUsd: usd, requestedQuantity: r.quantity };
      let block: { reason: CostBlockReason; detail: Record<string, unknown> } | null = null;
      if (policy.hardStoppedAt)
        block = { reason: "HARD_STOPPED", detail: { ...base, hardStopReason: policy.hardStopReason } };
      else if (r.paidOp !== undefined && !policy.paidOpsPermitted.includes(r.paidOp))
        block = { reason: "PAID_OP_NOT_PERMITTED", detail: { ...base, paidOp: r.paidOp } };
      else if (
        policy.dimensionLimits[r.dimension] !== undefined &&
        dimQty + r.quantity > policy.dimensionLimits[r.dimension]! + EPS
      )
        block = {
          reason: "DIMENSION_LIMIT",
          detail: {
            ...base,
            dimension: r.dimension,
            used: dimQty,
            limit: policy.dimensionLimits[r.dimension],
          },
        };
      else if (ledgerUsd + usd > policy.capUsd + EPS) block = { reason: "CAP_REACHED", detail: base };
      if (block) {
        await c.query(
          `INSERT INTO runtime.cost_blocks (tenant_id, workspace_id, entry_key, dimension, reason, requested_quantity, requested_usd, ledger_usd, cap_usd, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            r.tenantId,
            r.workspaceId,
            r.key,
            r.dimension,
            block.reason,
            r.quantity,
            usd,
            ledgerUsd,
            policy.capUsd,
            now.toISOString(),
          ],
        );
        if (block.reason === "CAP_REACHED" || block.reason === "DIMENSION_LIMIT")
          await c.query(
            "UPDATE runtime.cost_policies SET hard_stopped_at=COALESCE(hard_stopped_at,$3), hard_stop_reason=COALESCE(hard_stop_reason,$4) WHERE tenant_id=$1 AND workspace_id=$2",
            [r.tenantId, r.workspaceId, now.toISOString(), `${block.reason}:${r.dimension}`],
          );
        return { ok: false, reason: block.reason, detail: block.detail, policy };
      }
      await this.insert(c, r, usd, now);
      return {
        ok: true,
        res: { key: r.key, usd, state: "reserved", replay: false },
        policy,
        before: policy.capUsd > 0 ? ledgerUsd / policy.capUsd : 1,
        after: policy.capUsd > 0 ? (ledgerUsd + usd) / policy.capUsd : 1,
      };
    });
    if (!out.ok) {
      await this.o.audit?.write({
        tenantId: r.tenantId,
        workspaceId: r.workspaceId,
        runId: r.runId ?? null,
        actor: "cost-governor",
        kind: "cost.blocked",
        reasonCode: out.reason,
        detail: { dimension: r.dimension, key: r.key, ...out.detail },
      });
      await this.alert(out.policy, {
        tenantId: r.tenantId,
        workspaceId: r.workspaceId,
        key: `cost.blocked:${r.workspaceId}:${r.dimension}:${out.reason}`,
        kind: "cost.blocked",
        severity: "critical",
        title: `Spend blocked (${out.reason}) on ${r.dimension}`,
        detail: { dimension: r.dimension, reason: out.reason, ...out.detail },
      });
      throw new CostBlockedError(out.reason, `spend blocked before execution: ${out.reason}`, {
        dimension: r.dimension,
        ...out.detail,
      });
    }
    if (out.policy && !out.res.replay) await this.crossings(out.policy, r, out.before, out.after);
    return out.res;
  }

  private async insert(c: pg.PoolClient, r: SpendRequest, usd: number, now: Date): Promise<void> {
    await c.query(
      `INSERT INTO runtime.cost_ledger (tenant_id, workspace_id, run_id, entry_key, dimension, quantity, usd, state, paid_op, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9,$10)`,
      [
        r.tenantId,
        r.workspaceId,
        r.runId ?? null,
        r.key,
        r.dimension,
        r.quantity,
        usd,
        r.paidOp ?? null,
        JSON.stringify({ unit: COST_UNITS[r.dimension], ...(r.detail ?? {}) }),
        now.toISOString(),
      ],
    );
  }

  /** Replaces the reservation by the actual quantity and USD. An actual above estimate + allowance hard-stops. */
  async settle(
    tenantId: string,
    key: string,
    actual: { quantity: number; usd?: number },
  ): Promise<{ usd: number; overrunUsd: number }> {
    const now = this.clock();
    const res = await withTenant(this.pool, tenantId, async (c) => {
      const e = (await c.query("SELECT * FROM runtime.cost_ledger WHERE entry_key=$1 FOR UPDATE", [key]))
        .rows[0];
      if (!e) throw new Error(`unknown cost entry ${key}`);
      if (e.state !== "reserved")
        return {
          usd: Number(e.usd),
          overrunUsd: Number(e.overrun_usd),
          policy: null,
          ws: e.workspace_id as string,
        };
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cost:${tenantId}:${e.workspace_id}`]);
      const policy = await readPolicy(c, tenantId, e.workspace_id as string, true);
      const rate = policy?.rates[e.dimension as CostDimension] ?? 0;
      const usd = actual.usd ?? actual.quantity * rate;
      const overrun = Math.max(0, usd - Number(e.usd));
      await c.query(
        "UPDATE runtime.cost_ledger SET state='settled', quantity=$2, usd=$3, overrun_usd=$4, settled_at=$5 WHERE entry_key=$1",
        [key, actual.quantity, usd, overrun, now.toISOString()],
      );
      if (policy && overrun > policy.inflightAllowanceUsd + EPS)
        await c.query(
          "UPDATE runtime.cost_policies SET hard_stopped_at=COALESCE(hard_stopped_at,$3), hard_stop_reason=COALESCE(hard_stop_reason,'OVERRUN_BEYOND_ALLOWANCE') WHERE tenant_id=$1 AND workspace_id=$2",
          [tenantId, e.workspace_id, now.toISOString()],
        );
      return { usd, overrunUsd: overrun, policy, ws: e.workspace_id as string };
    });
    return { usd: res.usd, overrunUsd: res.overrunUsd };
  }

  /** The provider call failed before incurring cost: the reservation is returned. */
  async release(tenantId: string, key: string): Promise<void> {
    await withTenant(this.pool, tenantId, (c) =>
      c.query(
        "UPDATE runtime.cost_ledger SET state='released', settled_at=$2 WHERE entry_key=$1 AND state='reserved'",
        [key, this.clock().toISOString()],
      ),
    );
  }

  /** Authorise and settle in one step, for spend that is only known after the fact is NOT allowed here: use `observed`. */
  async spend<T>(
    r: SpendRequest,
    run: () => Promise<{ result: T; quantity: number; usd?: number }>,
  ): Promise<T> {
    await this.authorize(r);
    try {
      const o = await run();
      await this.settle(r.tenantId, r.key, {
        quantity: o.quantity,
        ...(o.usd !== undefined ? { usd: o.usd } : {}),
      });
      return o.result;
    } catch (e) {
      await this.release(r.tenantId, r.key);
      throw e;
    }
  }

  /**
   * Meters spend that has already happened (a collector read it from the provider: ClickHouse query_log, BigQuery
   * job statistics, an egress counter). It is counted in full and idempotent by key; it cannot be refused, but it
   * counts against every later authorisation, and crossing the cap hard-stops the workspace.
   */
  async observed(r: SpendRequest): Promise<void> {
    const now = this.clock();
    const policy = await withTenant(this.pool, r.tenantId, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cost:${r.tenantId}:${r.workspaceId}`]);
      const policy = await readPolicy(c, r.tenantId, r.workspaceId, true);
      const usd = r.usd ?? r.quantity * (policy?.rates[r.dimension] ?? 0);
      const ins = await c.query(
        `INSERT INTO runtime.cost_ledger (tenant_id, workspace_id, run_id, entry_key, dimension, quantity, usd, state, paid_op, detail, created_at, settled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'settled',$8,$9,$10,$10) ON CONFLICT (entry_key) DO NOTHING RETURNING 1`,
        [
          r.tenantId,
          r.workspaceId,
          r.runId ?? null,
          r.key,
          r.dimension,
          r.quantity,
          usd,
          r.paidOp ?? null,
          JSON.stringify({ unit: COST_UNITS[r.dimension], observed: true, ...(r.detail ?? {}) }),
          now.toISOString(),
        ],
      );
      if (!ins.rowCount || !policy) return null;
      const per = effectivePeriod(policy, now);
      const t = await c.query(
        "SELECT COALESCE(SUM(usd),0)::float8 AS usd FROM runtime.cost_ledger WHERE tenant_id=$1 AND workspace_id=$2 AND state IN ('reserved','settled') AND created_at >= $3",
        [r.tenantId, r.workspaceId, per.start.toISOString()],
      );
      const total = t.rows[0].usd as number;
      if (total > policy.capUsd + EPS)
        await c.query(
          "UPDATE runtime.cost_policies SET hard_stopped_at=COALESCE(hard_stopped_at,$3), hard_stop_reason=COALESCE(hard_stop_reason,'OBSERVED_SPEND_PAST_CAP') WHERE tenant_id=$1 AND workspace_id=$2",
          [r.tenantId, r.workspaceId, now.toISOString()],
        );
      return {
        policy,
        before: policy.capUsd > 0 ? (total - usd) / policy.capUsd : 1,
        after: policy.capUsd > 0 ? total / policy.capUsd : 1,
      };
    });
    if (policy) await this.crossings(policy.policy, r, policy.before, policy.after);
  }

  private async crossings(policy: CostPolicy, r: SpendRequest, before: number, after: number): Promise<void> {
    const levels = [...policy.alertThresholds, 1].sort((a, b) => a - b);
    for (const t of new Set(levels)) {
      if (before < t - EPS && after >= t - EPS)
        await this.alert(policy, {
          tenantId: r.tenantId,
          workspaceId: r.workspaceId,
          key: `cost.threshold:${r.workspaceId}:${t}:${policy.periodStart}`,
          kind: "cost.threshold",
          severity: t >= 1 ? "critical" : "warning",
          title: `Workspace spend reached ${(t * 100).toFixed(0)}% of its cap`,
          detail: { threshold: t, fraction: after, capUsd: policy.capUsd, dimension: r.dimension },
        });
    }
  }

  private alert(policy: CostPolicy, a: Parameters<typeof emitAlert>[2]) {
    return emitAlert(
      this.pool,
      this.o.sink,
      a,
      {
        maxPerWindow: policy.alertMaxPerWindow,
        windowSeconds: policy.alertWindowSeconds,
        cooldownSeconds: policy.alertCooldownSeconds,
      },
      this.clock(),
    );
  }
}
