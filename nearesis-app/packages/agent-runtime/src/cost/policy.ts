import type { CostDimension } from "./dimensions.ts";
import { isCostDimension } from "./dimensions.ts";
import type { CostPolicy, PolicyInput, Querier } from "./types.ts";

const num = (v: unknown) => Number(v);
const iso = (d: Date | string) => new Date(d).toISOString();

export function rowToPolicy(r: Record<string, unknown>): CostPolicy {
  return {
    tenantId: r.tenant_id as string,
    workspaceId: r.workspace_id as string,
    capUsd: num(r.cap_usd),
    periodStart: iso(r.period_start as Date),
    periodDays: r.period_days as number,
    dimensionLimits: r.dimension_limits as CostPolicy["dimensionLimits"],
    rates: r.rates as CostPolicy["rates"],
    paidOpsPermitted: r.paid_ops_permitted as string[],
    requirePriceFor: ((r.require_price_for as string[] | null) ?? []) as CostDimension[],
    inflightAllowanceUsd: num(r.inflight_allowance_usd),
    alertThresholds: r.alert_thresholds as number[],
    alertMaxPerWindow: r.alert_max_per_window as number,
    alertWindowSeconds: r.alert_window_seconds as number,
    alertCooldownSeconds: r.alert_cooldown_seconds as number,
    hardStoppedAt: r.hard_stopped_at ? iso(r.hard_stopped_at as Date) : null,
    hardStopReason: (r.hard_stop_reason as string | null) ?? null,
  };
}

export async function readPolicy(
  q: Querier,
  tenantId: string,
  workspaceId: string,
  lock = false,
): Promise<CostPolicy | null> {
  const r = await q.query(
    `SELECT * FROM runtime.cost_policies WHERE tenant_id=$1 AND workspace_id=$2 ${lock ? "FOR UPDATE" : ""}`,
    [tenantId, workspaceId],
  );
  return r.rows[0] ? rowToPolicy(r.rows[0]) : null;
}

/** Validates a policy body. Unknown dimensions, negative numbers and thresholds outside (0, 1] are rejected. */
export function validatePolicy(p: PolicyInput): string | null {
  if (!Number.isFinite(p.capUsd) || p.capUsd < 0) return "capUsd must be a finite number >= 0";
  for (const [k, v] of Object.entries({ ...(p.dimensionLimits ?? {}), ...(p.rates ?? {}) }))
    if (!isCostDimension(k) || !Number.isFinite(v) || (v as number) < 0) return `bad dimension entry ${k}`;
  for (const d of p.requirePriceFor ?? []) if (!isCostDimension(d)) return `bad requirePriceFor entry ${d}`;
  for (const t of p.alertThresholds ?? [])
    if (!(t > 0 && t <= 1)) return "alertThresholds must be fractions in (0, 1]";
  if (
    p.alertMaxPerWindow !== undefined &&
    (!Number.isInteger(p.alertMaxPerWindow) || p.alertMaxPerWindow < 0)
  )
    return "alertMaxPerWindow must be an integer >= 0";
  return null;
}

/** Upsert; changing the policy never clears a hard stop (only `resumeWorkspace` does). */
export async function upsertPolicy(
  q: Querier,
  tenantId: string,
  workspaceId: string,
  p: PolicyInput,
  now: Date,
): Promise<CostPolicy> {
  const bad = validatePolicy(p);
  if (bad) throw new Error(bad);
  const r = await q.query(
    `INSERT INTO runtime.cost_policies (tenant_id, workspace_id, cap_usd, period_start, period_days, dimension_limits, rates,
       paid_ops_permitted, inflight_allowance_usd, alert_thresholds, alert_max_per_window, alert_window_seconds,
       alert_cooldown_seconds, require_price_for, updated_at)
     VALUES ($1,$2,$3,$4,COALESCE($5,30),COALESCE($6,'{}'::jsonb),COALESCE($7,'{}'::jsonb),COALESCE($8,ARRAY['inference']::text[]),
       COALESCE($9::numeric,0),COALESCE($10,'[0.5,0.8,0.95]'::jsonb),COALESCE($11,3),COALESCE($12,3600),COALESCE($13,300),COALESCE($15::text[],'{}'::text[]),$14)
     ON CONFLICT (tenant_id, workspace_id) DO UPDATE SET
       cap_usd=EXCLUDED.cap_usd, period_start=$4,
       period_days=COALESCE($5,cost_policies.period_days),
       dimension_limits=COALESCE($6,cost_policies.dimension_limits), rates=COALESCE($7,cost_policies.rates),
       paid_ops_permitted=COALESCE($8,cost_policies.paid_ops_permitted),
       inflight_allowance_usd=COALESCE($9::numeric,cost_policies.inflight_allowance_usd),
       alert_thresholds=COALESCE($10,cost_policies.alert_thresholds),
       alert_max_per_window=COALESCE($11,cost_policies.alert_max_per_window),
       alert_window_seconds=COALESCE($12,cost_policies.alert_window_seconds),
       alert_cooldown_seconds=COALESCE($13,cost_policies.alert_cooldown_seconds),
       require_price_for=COALESCE($15::text[],cost_policies.require_price_for), updated_at=$14
     RETURNING *`,
    [
      tenantId,
      workspaceId,
      p.capUsd,
      p.periodStart ?? startOfMonth(now).toISOString(),
      p.periodDays ?? null,
      p.dimensionLimits ? JSON.stringify(p.dimensionLimits) : null,
      p.rates ? JSON.stringify(p.rates) : null,
      p.paidOpsPermitted ?? null,
      p.inflightAllowanceUsd ?? null,
      p.alertThresholds ? JSON.stringify(p.alertThresholds) : null,
      p.alertMaxPerWindow ?? null,
      p.alertWindowSeconds ?? null,
      p.alertCooldownSeconds ?? null,
      now.toISOString(),
      p.requirePriceFor ?? null,
    ],
  );
  return rowToPolicy(r.rows[0]);
}

export async function resumeWorkspace(
  q: Querier,
  tenantId: string,
  workspaceId: string,
  now: Date,
): Promise<boolean> {
  const r = await q.query(
    "UPDATE runtime.cost_policies SET hard_stopped_at=NULL, hard_stop_reason=NULL, updated_at=$3 WHERE tenant_id=$1 AND workspace_id=$2 RETURNING 1",
    [tenantId, workspaceId, now.toISOString()],
  );
  return (r.rowCount ?? 0) > 0;
}

export const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

/** The policy period containing `now` (periods repeat every `periodDays` from `periodStart`). */
export function effectivePeriod(p: Pick<CostPolicy, "periodStart" | "periodDays">, now: Date) {
  const len = p.periodDays * 86_400_000;
  const start0 = Date.parse(p.periodStart);
  const k = Math.max(0, Math.floor((now.getTime() - start0) / len));
  const start = start0 + k * len;
  return { start: new Date(start), end: new Date(start + len) };
}

export type { CostDimension };
