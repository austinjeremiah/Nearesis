import type { SpendGate, SpendGateRequest } from "@nearesis/contracts";
import type { CostDimension } from "./dimensions.ts";
import type { CostGovernor, SpendRequest } from "./governor.ts";

export interface SpendScope {
  tenantId: string;
  workspaceId: string;
  runId?: string | null;
}

/** Binds a `CostGovernor` to one tenant/workspace so adapters (which know nothing of tenancy) can gate their calls. */
export function scopedSpendGate(gov: CostGovernor, scope: SpendScope): SpendGate {
  const req = (r: SpendGateRequest): SpendRequest => ({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    runId: scope.runId ?? null,
    key: r.key,
    dimension: r.dimension as CostDimension,
    quantity: r.quantity,
    ...(r.usd !== undefined ? { usd: r.usd } : {}),
    ...(r.paidOp !== undefined ? { paidOp: r.paidOp } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
  });
  return {
    authorize: (r) => gov.authorize(req(r)),
    settle: (key, actual) => gov.settle(scope.tenantId, key, actual),
    release: (key) => gov.release(scope.tenantId, key),
    observe: (r) => gov.observed(req(r)),
  };
}

/** Scope for platform-level processes (ingestion, scheduler) from NEARESIS_COST_TENANT_ID / NEARESIS_COST_WORKSPACE_ID. */
export function spendScopeFromEnv(env: NodeJS.ProcessEnv = process.env): SpendScope {
  const tenantId = env.NEARESIS_COST_TENANT_ID;
  const workspaceId = env.NEARESIS_COST_WORKSPACE_ID;
  if (!tenantId || !workspaceId)
    throw new Error(
      "NEARESIS_COST_CONTROL=1 needs NEARESIS_COST_TENANT_ID and NEARESIS_COST_WORKSPACE_ID (fail closed: spend is not run unmetered)",
    );
  return { tenantId, workspaceId };
}

/** `execution.spendGate` for the kernel gateway: one scoped gate per tenant/workspace of an invocation. */
export function kernelSpendGateFactory(
  gov: CostGovernor | (() => CostGovernor | undefined),
): (scope: { tenantId: string; workspaceId: string }) => SpendGate | undefined {
  return (scope) => {
    const g = typeof gov === "function" ? gov() : gov;
    return g ? scopedSpendGate(g, scope) : undefined;
  };
}

/** Egress hosts whose calls cost money (NEARESIS_PAID_EGRESS_HOSTS, comma separated) need the `paid_api` permission. */
export function paidEgressOpFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): (host: string) => string | undefined {
  const hosts = new Set(
    (env.NEARESIS_PAID_EGRESS_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  return (host) => (hosts.has(host.toLowerCase()) ? "paid_api" : undefined);
}
