import { COST_DIMENSIONS } from "./dimensions.ts";
import type { CostDimension } from "./dimensions.ts";
import { MODEL_DIMENSION, readGlobalSpend } from "./global.ts";
import type { ExternalModelSpend, GlobalSpendStatus } from "./global.ts";
import { effectivePeriod, readPolicy } from "./policy.ts";
import type { Querier } from "./types.ts";

/**
 * Reconciliation (final_master_prompt s18: reservations -> actual charges -> reconciliation). Compares what was
 * reserved with what was actually charged, lists reservations that never settled, lists every entry whose price is
 * unknown, and checks that the global model-spend mirror agrees with the workspace ledger. Read-only.
 */
export interface DimensionReconciliation {
  dimension: CostDimension;
  reserved: { entries: number; usd: number };
  settled: { entries: number; usd: number };
  released: { entries: number };
  priceUnknown: { entries: number };
  /** Sum of reservation estimates and of actual charges over settled entries that had both; the variance is actual minus estimate. */
  estimateVsActual: { estimatedUsd: number; actualUsd: number; varianceUsd: number; comparedEntries: number };
}

export interface WorkspaceReconciliation {
  scope: "workspace";
  tenantId: string;
  workspaceId: string;
  period: { start: string; end: string };
  dimensions: DimensionReconciliation[];
  totals: {
    reservedOpenUsd: number;
    settledUsd: number;
    overrunUsd: number;
    priceUnknownEntries: number;
    blocks: number;
  };
  staleReservations: Array<{ key: string; dimension: string; usd: number | null; ageHours: number }>;
  priceUnknownEntries: Array<{ key: string; dimension: string; state: string; quantity: number }>;
  globalMirror: { checked: number; mismatches: Array<{ key: string; issue: string }> } | null;
  /** Human-readable findings; empty when everything agrees. */
  discrepancies: string[];
  reconciled: boolean;
  asOf: string;
}

export async function reconcileWorkspace(
  q: Querier,
  tenantId: string,
  workspaceId: string,
  now: Date,
  opts: { staleReservationHours?: number } = {},
): Promise<WorkspaceReconciliation> {
  const staleH = opts.staleReservationHours ?? 24;
  const policy = await readPolicy(q, tenantId, workspaceId);
  const per = policy
    ? effectivePeriod(policy, now)
    : {
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
      };
  const start = per.start.toISOString();
  const agg = await q.query(
    `SELECT dimension, state,
            count(*)::int AS n,
            COALESCE(SUM(usd),0)::float8 AS usd,
            count(*) FILTER (WHERE price_unknown)::int AS unknown,
            COALESCE(SUM(estimated_usd) FILTER (WHERE state='settled' AND NOT price_unknown AND estimated_usd IS NOT NULL),0)::float8 AS est,
            COALESCE(SUM(usd) FILTER (WHERE state='settled' AND NOT price_unknown AND estimated_usd IS NOT NULL),0)::float8 AS act,
            count(*) FILTER (WHERE state='settled' AND NOT price_unknown AND estimated_usd IS NOT NULL)::int AS cmp,
            COALESCE(SUM(overrun_usd),0)::float8 AS overrun
       FROM runtime.cost_ledger WHERE tenant_id=$1 AND workspace_id=$2 AND created_at >= $3 GROUP BY dimension, state`,
    [tenantId, workspaceId, start],
  );
  const dims = new Map<CostDimension, DimensionReconciliation>(
    COST_DIMENSIONS.map((d) => [
      d,
      {
        dimension: d,
        reserved: { entries: 0, usd: 0 },
        settled: { entries: 0, usd: 0 },
        released: { entries: 0 },
        priceUnknown: { entries: 0 },
        estimateVsActual: { estimatedUsd: 0, actualUsd: 0, varianceUsd: 0, comparedEntries: 0 },
      },
    ]),
  );
  let overrun = 0;
  for (const r of agg.rows) {
    const d = dims.get(r.dimension as CostDimension);
    if (!d) continue;
    if (r.state === "reserved") d.reserved = { entries: r.n, usd: r.usd };
    else if (r.state === "settled") {
      d.settled = { entries: r.n, usd: r.usd };
      d.estimateVsActual = {
        estimatedUsd: r.est,
        actualUsd: r.act,
        varianceUsd: r.act - r.est,
        comparedEntries: r.cmp,
      };
      overrun += r.overrun;
    } else d.released = { entries: r.n };
    if (r.state !== "released") d.priceUnknown.entries += r.unknown;
  }
  const stale = await q.query(
    `SELECT entry_key, dimension, usd::float8 AS usd, EXTRACT(EPOCH FROM ($4::timestamptz - created_at))/3600 AS age
       FROM runtime.cost_ledger WHERE tenant_id=$1 AND workspace_id=$2 AND state='reserved' AND created_at < $3 ORDER BY created_at`,
    [tenantId, workspaceId, new Date(now.getTime() - staleH * 3_600_000).toISOString(), now.toISOString()],
  );
  const unknown = await q.query(
    `SELECT entry_key, dimension, state, quantity::float8 AS quantity FROM runtime.cost_ledger
      WHERE tenant_id=$1 AND workspace_id=$2 AND created_at >= $3 AND price_unknown AND state<>'released' ORDER BY id DESC LIMIT 200`,
    [tenantId, workspaceId, start],
  );
  const blocks = await q.query(
    "SELECT count(*)::int AS n FROM runtime.cost_blocks WHERE tenant_id=$1 AND workspace_id=$2 AND created_at >= $3",
    [tenantId, workspaceId, start],
  );

  // Global mirror must agree with this workspace's model entries (same key, same state, same amount).
  const model = await q.query(
    `SELECT l.entry_key, l.state AS lstate, l.usd::float8 AS lusd, l.price_unknown AS lunk,
            m.state AS mstate, m.usd::float8 AS musd, m.price_unknown AS munk, (m.entry_key IS NULL) AS missing
       FROM runtime.cost_ledger l LEFT JOIN runtime.cost_global_model_spend m ON m.entry_key = l.entry_key
      WHERE l.tenant_id=$1 AND l.workspace_id=$2 AND l.dimension=$3 AND l.created_at >= $4`,
    [tenantId, workspaceId, MODEL_DIMENSION, start],
  );
  const mismatches: Array<{ key: string; issue: string }> = [];
  for (const r of model.rows) {
    if (r.missing)
      mismatches.push({ key: r.entry_key, issue: "model spend missing from the global ceiling mirror" });
    else if (r.lstate !== r.mstate)
      mismatches.push({ key: r.entry_key, issue: `state differs: ledger ${r.lstate}, global ${r.mstate}` });
    else if (r.lstate !== "released" && Math.abs((r.lusd ?? 0) - (r.musd ?? 0)) > 1e-9)
      mismatches.push({ key: r.entry_key, issue: `usd differs: ledger ${r.lusd}, global ${r.musd}` });
  }

  const discrepancies: string[] = [];
  if (stale.rows.length)
    discrepancies.push(`${stale.rows.length} reservation(s) older than ${staleH}h never settled or released`);
  for (const m of mismatches) discrepancies.push(`${m.key}: ${m.issue}`);
  const unknownN = [...dims.values()].reduce((s, d) => s + d.priceUnknown.entries, 0);
  if (unknownN)
    discrepancies.push(`${unknownN} entr(ies) have an unknown price and are not in any USD total`);

  const all = [...dims.values()];
  return {
    scope: "workspace",
    tenantId,
    workspaceId,
    period: { start, end: per.end.toISOString() },
    dimensions: all,
    totals: {
      reservedOpenUsd: all.reduce((s, d) => s + d.reserved.usd, 0),
      settledUsd: all.reduce((s, d) => s + d.settled.usd, 0),
      overrunUsd: overrun,
      priceUnknownEntries: unknownN,
      blocks: blocks.rows[0].n as number,
    },
    staleReservations: stale.rows.map((r) => ({
      key: r.entry_key,
      dimension: r.dimension,
      usd: r.usd,
      ageHours: Math.round(r.age * 100) / 100,
    })),
    priceUnknownEntries: unknown.rows.map((r) => ({
      key: r.entry_key,
      dimension: r.dimension,
      state: r.state,
      quantity: r.quantity,
    })),
    globalMirror: { checked: model.rows.length, mismatches },
    discrepancies,
    reconciled: discrepancies.length === 0,
    asOf: now.toISOString(),
  };
}

export interface GlobalReconciliation {
  scope: "global";
  status: GlobalSpendStatus;
  staleReservations: Array<{ key: string; usd: number | null; ageHours: number }>;
  discrepancies: string[];
  reconciled: boolean;
  asOf: string;
}

/** Global model-spend reconciliation: open reservations that never settled, unknown prices, and the ceiling check itself. */
export async function reconcileGlobal(
  q: Querier,
  now: Date,
  opts: { staleReservationHours?: number; externalModelSpend?: ExternalModelSpend } = {},
): Promise<GlobalReconciliation> {
  const staleH = opts.staleReservationHours ?? 24;
  const status = await readGlobalSpend(q, now, opts.externalModelSpend);
  const stale = await q.query(
    `SELECT entry_key, usd::float8 AS usd, EXTRACT(EPOCH FROM ($2::timestamptz - created_at))/3600 AS age
       FROM runtime.cost_global_model_spend WHERE state='reserved' AND created_at < $1 ORDER BY created_at`,
    [new Date(now.getTime() - staleH * 3_600_000).toISOString(), now.toISOString()],
  );
  const discrepancies: string[] = [];
  if (status.committedUsd > status.ceilingUsd + 1e-9)
    discrepancies.push(
      `committed USD ${status.committedUsd} is above the ceiling USD ${status.ceilingUsd} (observed spend cannot be refused)`,
    );
  if (stale.rows.length)
    discrepancies.push(`${stale.rows.length} model reservation(s) older than ${staleH}h never settled`);
  if (status.unknownPriceEntries)
    discrepancies.push(
      `${status.unknownPriceEntries} model entr(ies) have an unknown price and are not counted`,
    );
  return {
    scope: "global",
    status,
    staleReservations: stale.rows.map((r) => ({
      key: r.entry_key,
      usd: r.usd,
      ageHours: Math.round(r.age * 100) / 100,
    })),
    discrepancies,
    reconciled: discrepancies.length === 0,
    asOf: now.toISOString(),
  };
}
