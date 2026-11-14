import { COST_DIMENSIONS, COST_UNITS } from "./dimensions.ts";
import type { CostDimension } from "./dimensions.ts";
import { effectivePeriod, readPolicy } from "./policy.ts";
import type { CostPolicy, Querier } from "./types.ts";

export interface DimensionBurn {
  dimension: CostDimension;
  unit: string;
  /** null = never metered in the period (distinct from 0 metered). */
  quantity: number | null;
  usd: number | null;
  limit: number | null;
  limitFraction: number | null;
}

export interface Forecast {
  /** Always "projection": a linear extrapolation of the period so far, never an observed or billed value. */
  label: "projection";
  method: "linear_to_period_end";
  basis: { elapsedHours: number; spentUsd: number; entries: number };
  projectedPeriodUsd: number | null;
  projectedOverCap: boolean | null;
  /** From the trailing-24h burn rate; null when there is no recent spend. */
  projectedExhaustionAt: string | null;
  /** "insufficient_data" when fewer than 3 settled entries or under one hour of the period have elapsed. */
  confidence: "ok" | "insufficient_data";
  /** Plain-language assumptions behind the number; always shown with it (final_master_prompt s18). */
  assumptions: string[];
}

export interface WorkspaceBurn {
  tenantId: string;
  workspaceId: string;
  period: { start: string; end: string };
  policy: CostPolicy | null;
  spentUsd: number;
  reservedUsd: number;
  capUsd: number | null;
  burnFraction: number | null;
  /** USD per hour over the trailing hour and 24 hours. */
  burnRateUsdPerHour: { last1h: number; last24h: number };
  hardStopped: boolean;
  hardStopReason: string | null;
  dimensions: DimensionBurn[];
  forecast: Forecast;
  blocks: { total: number; byReason: Record<string, number> };
  alerts: { sent: number; suppressed: number };
  /** Entries whose price was unknown: never counted as USD 0, listed here so the figures are not read as complete. */
  priceUnknown: { entries: number; byDimension: Record<string, number> };
  asOf: string;
}

/** Pure projection (unit-tested): spend so far scaled to the period length. */
export function project(a: {
  spentUsd: number;
  entries: number;
  periodStart: Date;
  periodEnd: Date;
  now: Date;
  capUsd: number | null;
  remainingUsd: number | null;
  rate24hUsdPerHour: number;
  priceUnknownEntries?: number;
}): Forecast {
  const elapsedMs = Math.max(0, a.now.getTime() - a.periodStart.getTime());
  const elapsedHours = elapsedMs / 3_600_000;
  const lenMs = a.periodEnd.getTime() - a.periodStart.getTime();
  const enough = a.entries >= 3 && elapsedHours >= 1;
  const projected = enough ? a.spentUsd * (lenMs / elapsedMs) : null;
  return {
    label: "projection",
    method: "linear_to_period_end",
    basis: { elapsedHours: Math.round(elapsedHours * 1000) / 1000, spentUsd: a.spentUsd, entries: a.entries },
    projectedPeriodUsd: projected,
    projectedOverCap: projected !== null && a.capUsd !== null ? projected > a.capUsd : null,
    projectedExhaustionAt:
      a.remainingUsd !== null && a.rate24hUsdPerHour > 0
        ? new Date(a.now.getTime() + (a.remainingUsd / a.rate24hUsdPerHour) * 3_600_000).toISOString()
        : null,
    confidence: enough ? "ok" : "insufficient_data",
    assumptions: [
      "Linear: spend so far (settled plus reserved) is scaled to the whole policy period.",
      "Exhaustion time assumes the trailing 24 hour spend rate continues unchanged.",
      "Needs at least 3 settled entries and 1 hour of the period elapsed; otherwise no projection is made.",
      a.priceUnknownEntries
        ? `${a.priceUnknownEntries} entries with an unknown price are excluded; the real figure may be higher.`
        : "No entries with an unknown price in the period.",
    ],
  };
}

export async function readBurn(
  q: Querier,
  tenantId: string,
  workspaceId: string,
  now: Date,
): Promise<WorkspaceBurn> {
  const policy = await readPolicy(q, tenantId, workspaceId);
  const per = policy
    ? effectivePeriod(policy, now)
    : {
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
      };
  const start = per.start.toISOString();
  const t = await q.query(
    `SELECT dimension, state, COALESCE(SUM(quantity),0)::float8 AS qty, COALESCE(SUM(usd),0)::float8 AS usd, count(*)::int AS n,
            COALESCE(SUM(usd) FILTER (WHERE created_at >= $4),0)::float8 AS usd1h,
            COALESCE(SUM(usd) FILTER (WHERE created_at >= $5),0)::float8 AS usd24h
       FROM runtime.cost_ledger WHERE tenant_id=$1 AND workspace_id=$2 AND created_at >= $3 AND state IN ('reserved','settled')
      GROUP BY dimension, state`,
    [
      tenantId,
      workspaceId,
      start,
      new Date(now.getTime() - 3_600_000).toISOString(),
      new Date(now.getTime() - 86_400_000).toISOString(),
    ],
  );
  let spent = 0,
    reserved = 0,
    entries = 0,
    u1 = 0,
    u24 = 0;
  const dim = new Map<string, { q: number; usd: number }>();
  for (const r of t.rows) {
    if (r.state === "settled") {
      spent += r.usd;
      entries += r.n;
    } else reserved += r.usd;
    u1 += r.usd1h;
    u24 += r.usd24h;
    const d = dim.get(r.dimension) ?? { q: 0, usd: 0 };
    d.q += r.qty;
    d.usd += r.usd;
    dim.set(r.dimension, d);
  }
  const b = await q.query(
    "SELECT reason, count(*)::int AS n FROM runtime.cost_blocks WHERE tenant_id=$1 AND workspace_id=$2 AND created_at >= $3 GROUP BY reason",
    [tenantId, workspaceId, start],
  );
  const a = await q.query(
    "SELECT status, count(*)::int AS n FROM runtime.ops_alerts WHERE tenant_id=$1 AND workspace_id=$2 AND created_at >= $3 GROUP BY status",
    [tenantId, workspaceId, start],
  );
  const pu = await q.query(
    `SELECT dimension, count(*)::int AS n FROM runtime.cost_ledger
      WHERE tenant_id=$1 AND workspace_id=$2 AND created_at >= $3 AND price_unknown AND state IN ('reserved','settled') GROUP BY dimension`,
    [tenantId, workspaceId, start],
  );
  const unknownEntries = pu.rows.reduce((s2: number, r: { n: number }) => s2 + r.n, 0);
  const cap = policy?.capUsd ?? null;
  const committed = spent + reserved;
  return {
    tenantId,
    workspaceId,
    period: { start, end: per.end.toISOString() },
    policy,
    spentUsd: spent,
    reservedUsd: reserved,
    capUsd: cap,
    burnFraction: cap !== null && cap > 0 ? committed / cap : null,
    burnRateUsdPerHour: { last1h: u1, last24h: u24 / 24 },
    hardStopped: !!policy?.hardStoppedAt,
    hardStopReason: policy?.hardStopReason ?? null,
    dimensions: COST_DIMENSIONS.map((d): DimensionBurn => {
      const x = dim.get(d);
      const limit = policy?.dimensionLimits[d] ?? null;
      return {
        dimension: d,
        unit: COST_UNITS[d],
        quantity: x ? x.q : null,
        usd: x ? x.usd : null,
        limit,
        limitFraction: limit !== null && limit > 0 ? (x?.q ?? 0) / limit : null,
      };
    }),
    forecast: project({
      spentUsd: committed,
      entries,
      periodStart: per.start,
      periodEnd: per.end,
      now,
      capUsd: cap,
      remainingUsd: cap === null ? null : Math.max(0, cap - committed),
      rate24hUsdPerHour: u24 / 24,
      priceUnknownEntries: unknownEntries,
    }),
    blocks: {
      total: b.rows.reduce((s: number, r: { n: number }) => s + r.n, 0),
      byReason: Object.fromEntries(b.rows.map((r: { reason: string; n: number }) => [r.reason, r.n])),
    },
    alerts: {
      sent: a.rows.find((r: { status: string }) => r.status === "sent")?.n ?? 0,
      suppressed: a.rows.find((r: { status: string }) => r.status === "suppressed")?.n ?? 0,
    },
    priceUnknown: {
      entries: unknownEntries,
      byDimension: Object.fromEntries(
        pu.rows.map((r: { dimension: string; n: number }) => [r.dimension, r.n]),
      ),
    },
    asOf: now.toISOString(),
  };
}

export interface LedgerExport {
  entries: Array<{
    key: string;
    dimension: CostDimension;
    quantity: number;
    /** null = the price was unknown (`priceUnknown`); never 0. */
    usd: number | null;
    priceUnknown: boolean;
    state: string;
    paidOp: string | null;
    createdAt: string;
  }>;
  blocks: Array<{
    key: string | null;
    dimension: string;
    reason: string;
    requestedUsd: number | null;
    ledgerUsd: number;
    createdAt: string;
  }>;
}

export async function exportLedger(
  q: Querier,
  tenantId: string,
  workspaceId: string,
  limit = 1000,
): Promise<LedgerExport> {
  const e = await q.query(
    "SELECT entry_key, dimension, quantity::float8 AS quantity, usd::float8 AS usd, price_unknown, state, paid_op, created_at FROM runtime.cost_ledger WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY id DESC LIMIT $3",
    [tenantId, workspaceId, limit],
  );
  const b = await q.query(
    "SELECT entry_key, dimension, reason, requested_usd::float8 AS requested_usd, ledger_usd::float8 AS ledger_usd, created_at FROM runtime.cost_blocks WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY id DESC LIMIT $3",
    [tenantId, workspaceId, limit],
  );
  return {
    entries: e.rows.map((r) => ({
      key: r.entry_key,
      dimension: r.dimension,
      quantity: r.quantity,
      usd: r.usd,
      priceUnknown: !!r.price_unknown,
      state: r.state,
      paidOp: r.paid_op,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    blocks: b.rows.map((r) => ({
      key: r.entry_key,
      dimension: r.dimension,
      reason: r.reason,
      requestedUsd: r.requested_usd,
      ledgerUsd: r.ledger_usd,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  };
}
