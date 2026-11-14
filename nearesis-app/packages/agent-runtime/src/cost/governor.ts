import type pg from "pg";
import { AgentRuntimeError } from "../errors.ts";
import { withTenant } from "../tenant.ts";
import type { AuditSink } from "../audit.ts";
import { emitAlert } from "./alerts.ts";
import { COST_UNITS, isCostDimension } from "./dimensions.ts";
import type { CostDimension } from "./dimensions.ts";
import { effectivePeriod, readPolicy } from "./policy.ts";
import {
  GLOBAL_ADVISORY_LOCK,
  GLOBAL_EPS,
  MODEL_DIMENSION,
  MODEL_SPEND_CEILING_USD,
  globalThresholdAlerts,
  readGlobalCommitted,
  readGlobalPolicy,
} from "./global.ts";
import type { ExternalModelSpend } from "./global.ts";
import type { AlertSink, CostPolicy, Querier } from "./types.ts";

export type CostBlockReason =
  | "CAP_REACHED"
  | "DIMENSION_LIMIT"
  | "PAID_OP_NOT_PERMITTED"
  | "HARD_STOPPED"
  | "PRICE_UNKNOWN"
  | "GLOBAL_CEILING";

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
  /**
   * Estimated USD; defaults to quantity x the policy rate for the dimension. With neither, the price is UNKNOWN: it is
   * recorded as `price_unknown` (never as 0) and blocked where a price is required.
   */
  usd?: number;
  /** Set for operations that cost money at an external provider; must be listed in the policy's paidOpsPermitted. */
  paidOp?: string;
  detail?: Record<string, unknown>;
}
export interface Reservation {
  key: string;
  /** null when the price is unknown (`priceUnknown`). */
  usd: number | null;
  priceUnknown: boolean;
  state: "reserved" | "settled" | "released";
  /** true when the key already existed (replay). */
  replay: boolean;
}

export interface GovernorOptions {
  pool: pg.Pool;
  audit?: AuditSink;
  sink?: AlertSink;
  clock?: () => Date;
  /** Model spend recorded outside the Postgres ledger (e.g. the inference spend file); counted against the global ceiling. */
  externalModelSpend?: ExternalModelSpend;
  /** Lowers the global model ceiling below the policy row (tests); it can never exceed USD 5. */
  globalCeilingUsd?: number;
}

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

  private async globalCeiling(c: Querier): Promise<number> {
    const p = await readGlobalPolicy(c);
    return Math.min(
      p.modelCeilingUsd,
      this.o.globalCeilingUsd ?? MODEL_SPEND_CEILING_USD,
      MODEL_SPEND_CEILING_USD,
    );
  }

  async authorize(r: SpendRequest): Promise<Reservation> {
    if (!isCostDimension(r.dimension)) throw new Error(`unknown cost dimension ${r.dimension}`);
    if (!Number.isFinite(r.quantity) || r.quantity < 0)
      throw new Error("quantity must be a finite number >= 0");
    if (r.usd !== undefined && (!Number.isFinite(r.usd) || r.usd < 0))
      throw new Error("usd must be a finite number >= 0");
    const now = this.clock();
    const isModel = r.dimension === MODEL_DIMENSION;
    type Crossing = { before: number; after: number; ceilingUsd: number; thresholds: number[] };
    type Outcome =
      | {
          ok: true;
          res: Reservation;
          policy: CostPolicy | null;
          before: number;
          after: number;
          global: Crossing | null;
        }
      | { ok: false; reason: CostBlockReason; detail: Record<string, unknown>; policy: CostPolicy | null };
    const out = await withTenant(this.pool, r.tenantId, async (c): Promise<Outcome> => {
      // Lock order is always global -> workspace, so two workspaces racing for the last of the ceiling serialise.
      if (isModel) await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [GLOBAL_ADVISORY_LOCK]);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cost:${r.tenantId}:${r.workspaceId}`]);
      const prior = await c.query(
        "SELECT usd, state, price_unknown FROM runtime.cost_ledger WHERE entry_key=$1",
        [r.key],
      );
      if (prior.rows[0])
        return {
          ok: true,
          res: {
            key: r.key,
            usd: prior.rows[0].usd === null ? null : Number(prior.rows[0].usd),
            priceUnknown: !!prior.rows[0].price_unknown,
            state: prior.rows[0].state,
            replay: true,
          },
          policy: null,
          before: 0,
          after: 0,
          global: null,
        };
      const policy = await readPolicy(c, r.tenantId, r.workspaceId, true);
      const rate = policy?.rates[r.dimension];
      const usd: number | null = r.usd !== undefined ? r.usd : rate !== undefined ? r.quantity * rate : null;
      // Model spend always needs a price (the global ceiling applies to every workspace); other dimensions only when the owner says so.
      const priceRequired = isModel || (policy?.requirePriceFor.includes(r.dimension) ?? false);
      const per = policy ? effectivePeriod(policy, now) : null;
      let ledgerUsd = 0;
      let dimQty = 0;
      if (policy && per) {
        const t = await c.query(
          `SELECT COALESCE(SUM(usd),0)::float8 AS usd,
                  COALESCE(SUM(quantity) FILTER (WHERE dimension=$4),0)::float8 AS q
             FROM runtime.cost_ledger
            WHERE tenant_id=$1 AND workspace_id=$2 AND state IN ('reserved','settled') AND created_at >= $3`,
          [r.tenantId, r.workspaceId, per.start.toISOString(), r.dimension],
        );
        ledgerUsd = t.rows[0].usd as number;
        dimQty = t.rows[0].q as number;
      }
      const base = {
        ledgerUsd,
        capUsd: policy?.capUsd ?? null,
        requestedUsd: usd,
        requestedQuantity: r.quantity,
      };
      let block: { reason: CostBlockReason; detail: Record<string, unknown> } | null = null;
      let gCommitted = 0;
      let gCeiling = MODEL_SPEND_CEILING_USD;
      let gThresholds: number[] = [0.5, 0.8, 0.95];
      if (policy?.hardStoppedAt)
        block = { reason: "HARD_STOPPED", detail: { ...base, hardStopReason: policy.hardStopReason } };
      else if (policy && r.paidOp !== undefined && !policy.paidOpsPermitted.includes(r.paidOp))
        block = { reason: "PAID_OP_NOT_PERMITTED", detail: { ...base, paidOp: r.paidOp } };
      else if (usd === null && priceRequired)
        block = {
          reason: "PRICE_UNKNOWN",
          detail: {
            ...base,
            dimension: r.dimension,
            note: "No price is configured for this dimension and the caller gave none; paid work is blocked rather than recorded as USD 0.",
          },
        };
      else if (
        policy &&
        policy.dimensionLimits[r.dimension] !== undefined &&
        dimQty + r.quantity > policy.dimensionLimits[r.dimension]! + GLOBAL_EPS
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
      if (!block && isModel) {
        gCeiling = await this.globalCeiling(c);
        gThresholds = (await readGlobalPolicy(c)).alertThresholds;
        gCommitted = (await readGlobalCommitted(c, this.o.externalModelSpend)).committedUsd;
        if (gCommitted + (usd ?? 0) > gCeiling + GLOBAL_EPS)
          block = {
            reason: "GLOBAL_CEILING",
            detail: {
              scope: "global",
              dimension: r.dimension,
              committedUsd: gCommitted,
              ceilingUsd: gCeiling,
              requestedUsd: usd,
              requestedQuantity: r.quantity,
              note: "One global model-spend ceiling applies to every workspace together.",
            },
          };
      }
      if (!block && policy && usd !== null && ledgerUsd + usd > policy.capUsd + GLOBAL_EPS)
        block = { reason: "CAP_REACHED", detail: base };
      if (block) {
        const global = block.reason === "GLOBAL_CEILING";
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
            global ? gCommitted : ledgerUsd,
            global ? gCeiling : (policy?.capUsd ?? null),
            now.toISOString(),
          ],
        );
        if (policy && (block.reason === "CAP_REACHED" || block.reason === "DIMENSION_LIMIT"))
          await c.query(
            "UPDATE runtime.cost_policies SET hard_stopped_at=COALESCE(hard_stopped_at,$3), hard_stop_reason=COALESCE(hard_stop_reason,$4) WHERE tenant_id=$1 AND workspace_id=$2",
            [r.tenantId, r.workspaceId, now.toISOString(), `${block.reason}:${r.dimension}`],
          );
        return { ok: false, reason: block.reason, detail: block.detail, policy };
      }
      await this.insert(c, r, usd, now);
      if (isModel) await this.mirrorInsert(c, r.key, usd, "reserved", now);
      return {
        ok: true,
        res: { key: r.key, usd, priceUnknown: usd === null, state: "reserved", replay: false },
        policy,
        before: policy && policy.capUsd > 0 ? ledgerUsd / policy.capUsd : 1,
        after: policy && policy.capUsd > 0 ? (ledgerUsd + (usd ?? 0)) / policy.capUsd : 1,
        global: isModel
          ? {
              before: gCommitted,
              after: gCommitted + (usd ?? 0),
              ceilingUsd: gCeiling,
              thresholds: gThresholds,
            }
          : null,
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
    if (out.global) await this.globalCrossings(out.global);
    return out.res;
  }

  private async insert(c: pg.PoolClient, r: SpendRequest, usd: number | null, now: Date): Promise<void> {
    await c.query(
      `INSERT INTO runtime.cost_ledger (tenant_id, workspace_id, run_id, entry_key, dimension, quantity, usd, estimated_usd, price_unknown, state, paid_op, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,'reserved',$9,$10,$11)`,
      [
        r.tenantId,
        r.workspaceId,
        r.runId ?? null,
        r.key,
        r.dimension,
        r.quantity,
        usd,
        usd === null,
        r.paidOp ?? null,
        JSON.stringify({ unit: COST_UNITS[r.dimension], ...(r.detail ?? {}) }),
        now.toISOString(),
      ],
    );
  }

  private async mirrorInsert(
    c: Querier,
    key: string,
    usd: number | null,
    state: "reserved" | "settled",
    now: Date,
  ): Promise<void> {
    await c.query(
      `INSERT INTO runtime.cost_global_model_spend (entry_key, usd, price_unknown, state, created_at, settled_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (entry_key) DO NOTHING`,
      [key, usd, usd === null, state, now.toISOString(), state === "settled" ? now.toISOString() : null],
    );
  }

  /**
   * Replaces the reservation by the actual quantity and USD. An actual above estimate + allowance hard-stops. When the
   * actual price is unknown the entry keeps its reservation estimate (conservative for the caps), is flagged
   * `price_unknown`, and is never turned into 0.
   */
  async settle(
    tenantId: string,
    key: string,
    actual: { quantity: number; usd?: number },
  ): Promise<{ usd: number | null; overrunUsd: number; priceUnknown: boolean }> {
    const now = this.clock();
    const res = await withTenant(this.pool, tenantId, async (c) => {
      const e = (await c.query("SELECT * FROM runtime.cost_ledger WHERE entry_key=$1 FOR UPDATE", [key]))
        .rows[0];
      if (!e) throw new Error(`unknown cost entry ${key}`);
      if (e.state !== "reserved")
        return {
          usd: e.usd === null ? null : Number(e.usd),
          overrunUsd: Number(e.overrun_usd),
          priceUnknown: !!e.price_unknown,
          global: null as null | { before: number; after: number; ceilingUsd: number; thresholds: number[] },
        };
      const isModel = e.dimension === MODEL_DIMENSION;
      if (isModel) await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [GLOBAL_ADVISORY_LOCK]);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cost:${tenantId}:${e.workspace_id}`]);
      const policy = await readPolicy(c, tenantId, e.workspace_id as string, true);
      const rate = policy?.rates[e.dimension as CostDimension];
      const priced: number | null =
        actual.usd !== undefined ? actual.usd : rate !== undefined ? actual.quantity * rate : null;
      const estimate = e.usd === null ? null : Number(e.usd);
      const unknown = priced === null;
      const usd = priced ?? estimate; // unknown actual: keep the estimate, flagged, never 0
      const overrun = !unknown && estimate !== null ? Math.max(0, (priced as number) - estimate) : 0;
      let gBefore = 0;
      if (isModel) gBefore = (await readGlobalCommitted(c, this.o.externalModelSpend)).committedUsd;
      await c.query(
        "UPDATE runtime.cost_ledger SET state='settled', quantity=$2, usd=$3, price_unknown=$4, overrun_usd=$5, settled_at=$6 WHERE entry_key=$1",
        [key, actual.quantity, usd, unknown, overrun, now.toISOString()],
      );
      let global = null as null | { before: number; after: number; ceilingUsd: number; thresholds: number[] };
      if (isModel) {
        await c.query(
          "UPDATE runtime.cost_global_model_spend SET state='settled', usd=$2, price_unknown=$3, settled_at=$4 WHERE entry_key=$1",
          [key, usd, unknown, now.toISOString()],
        );
        global = {
          before: gBefore,
          after: gBefore - (estimate ?? 0) + (usd ?? 0),
          ceilingUsd: await this.globalCeiling(c),
          thresholds: (await readGlobalPolicy(c)).alertThresholds,
        };
      }
      if (policy && overrun > policy.inflightAllowanceUsd + GLOBAL_EPS)
        await c.query(
          "UPDATE runtime.cost_policies SET hard_stopped_at=COALESCE(hard_stopped_at,$3), hard_stop_reason=COALESCE(hard_stop_reason,'OVERRUN_BEYOND_ALLOWANCE') WHERE tenant_id=$1 AND workspace_id=$2",
          [tenantId, e.workspace_id, now.toISOString()],
        );
      return { usd, overrunUsd: overrun, priceUnknown: unknown, global };
    });
    if (res.global) await this.globalCrossings(res.global);
    return { usd: res.usd, overrunUsd: res.overrunUsd, priceUnknown: res.priceUnknown };
  }

  /** The provider call failed before incurring cost: the reservation is returned. */
  async release(tenantId: string, key: string): Promise<void> {
    await withTenant(this.pool, tenantId, async (c) => {
      const r = await c.query(
        "UPDATE runtime.cost_ledger SET state='released', settled_at=$2 WHERE entry_key=$1 AND state='reserved' RETURNING dimension",
        [key, this.clock().toISOString()],
      );
      if (r.rows[0]?.dimension === MODEL_DIMENSION) {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [GLOBAL_ADVISORY_LOCK]);
        await c.query(
          "UPDATE runtime.cost_global_model_spend SET state='released', settled_at=$2 WHERE entry_key=$1 AND state='reserved'",
          [key, this.clock().toISOString()],
        );
      }
    });
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
   * counts against every later authorisation, and crossing the cap hard-stops the workspace. An unknown price is
   * recorded as `price_unknown` (usd NULL), never as 0.
   */
  async observed(r: SpendRequest): Promise<void> {
    const now = this.clock();
    const isModel = r.dimension === MODEL_DIMENSION;
    const outcome = await withTenant(this.pool, r.tenantId, async (c) => {
      if (isModel) await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [GLOBAL_ADVISORY_LOCK]);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cost:${r.tenantId}:${r.workspaceId}`]);
      const policy = await readPolicy(c, r.tenantId, r.workspaceId, true);
      const rate = policy?.rates[r.dimension];
      const usd: number | null = r.usd !== undefined ? r.usd : rate !== undefined ? r.quantity * rate : null;
      let gBefore = 0;
      if (isModel) gBefore = (await readGlobalCommitted(c, this.o.externalModelSpend)).committedUsd;
      const ins = await c.query(
        `INSERT INTO runtime.cost_ledger (tenant_id, workspace_id, run_id, entry_key, dimension, quantity, usd, estimated_usd, price_unknown, state, paid_op, detail, created_at, settled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,'settled',$9,$10,$11,$11) ON CONFLICT (entry_key) DO NOTHING RETURNING 1`,
        [
          r.tenantId,
          r.workspaceId,
          r.runId ?? null,
          r.key,
          r.dimension,
          r.quantity,
          usd,
          usd === null,
          r.paidOp ?? null,
          JSON.stringify({ unit: COST_UNITS[r.dimension], observed: true, ...(r.detail ?? {}) }),
          now.toISOString(),
        ],
      );
      if (!ins.rowCount) return null;
      let global: { before: number; after: number; ceilingUsd: number; thresholds: number[] } | null = null;
      if (isModel) {
        await this.mirrorInsert(c, r.key, usd, "settled", now);
        global = {
          before: gBefore,
          after: gBefore + (usd ?? 0),
          ceilingUsd: await this.globalCeiling(c),
          thresholds: (await readGlobalPolicy(c)).alertThresholds,
        };
      }
      if (!policy) return { policy: null, before: 0, after: 0, global };
      const per = effectivePeriod(policy, now);
      const t = await c.query(
        "SELECT COALESCE(SUM(usd),0)::float8 AS usd FROM runtime.cost_ledger WHERE tenant_id=$1 AND workspace_id=$2 AND state IN ('reserved','settled') AND created_at >= $3",
        [r.tenantId, r.workspaceId, per.start.toISOString()],
      );
      const total = t.rows[0].usd as number;
      if (total > policy.capUsd + GLOBAL_EPS)
        await c.query(
          "UPDATE runtime.cost_policies SET hard_stopped_at=COALESCE(hard_stopped_at,$3), hard_stop_reason=COALESCE(hard_stop_reason,'OBSERVED_SPEND_PAST_CAP') WHERE tenant_id=$1 AND workspace_id=$2",
          [r.tenantId, r.workspaceId, now.toISOString()],
        );
      return {
        policy,
        before: policy.capUsd > 0 ? (total - (usd ?? 0)) / policy.capUsd : 1,
        after: policy.capUsd > 0 ? total / policy.capUsd : 1,
        global,
      };
    });
    if (!outcome) return;
    if (outcome.policy) await this.crossings(outcome.policy, r, outcome.before, outcome.after);
    if (outcome.global) await this.globalCrossings(outcome.global);
  }

  private async globalCrossings(g: {
    before: number;
    after: number;
    ceilingUsd: number;
    thresholds: number[];
  }) {
    for (const a of globalThresholdAlerts(g.thresholds, g.ceilingUsd, g.before, g.after))
      await emitAlert(
        this.pool,
        this.o.sink,
        a,
        { maxPerWindow: 10, windowSeconds: 3600, cooldownSeconds: 0 },
        this.clock(),
      );
  }

  private async crossings(policy: CostPolicy, r: SpendRequest, before: number, after: number): Promise<void> {
    const levels = [...policy.alertThresholds, 1].sort((a, b) => a - b);
    for (const t of new Set(levels)) {
      if (before < t - GLOBAL_EPS && after >= t - GLOBAL_EPS)
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

  private alert(policy: CostPolicy | null, a: Parameters<typeof emitAlert>[2]) {
    return emitAlert(
      this.pool,
      this.o.sink,
      a,
      {
        maxPerWindow: policy?.alertMaxPerWindow ?? 3,
        windowSeconds: policy?.alertWindowSeconds ?? 3600,
        cooldownSeconds: policy?.alertCooldownSeconds ?? 300,
      },
      this.clock(),
    );
  }
}
