import { UsdCreditsService, microToUsd, usdNumberToMicro } from "@nearesis/kernel";
import type { Db, Kernel, Session, TenantContext, UsdCategory } from "@nearesis/kernel";

const services = new WeakMap<Db, UsdCreditsService>();
/** One USD credits service per database handle (the allowance is read from NEARESIS_USER_CREDIT_USD once). */
export function usdCreditsOf(db: Db): UsdCreditsService {
  let s = services.get(db);
  if (!s) {
    s = new UsdCreditsService(db);
    services.set(db, s);
  }
  return s;
}
export const tenantOf = (s: Session): TenantContext => ({ orgId: s.principal.orgId, userId: s.userId });

/** Gate before any model spend or paid operation: throws CreditsExhausted (402) when available is zero or below `required`. */
export async function requireCredits(kernel: Kernel, s: Session, requiredMicro?: bigint): Promise<void> {
  const svc = usdCreditsOf(kernel.db);
  await svc.reconcileRuns(s.userId).catch(() => undefined);
  await svc.require(tenantOf(s), requiredMicro);
}

/**
 * Charges model spend that already happened (the ACTUAL recorded USD of a finished call or turn) to the caller.
 * Idempotent per (refKind, refId, model). Never throws into the request: a failed write is logged by the caller's hook.
 */
export async function chargeModelUsd(
  db: Db,
  ctx: TenantContext,
  usd: number,
  ref: { refKind: string; refId: string; detail?: Record<string, unknown> },
): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const micro = usdNumberToMicro(usd);
  await usdCreditsOf(db).charge(ctx, micro, {
    refKind: ref.refKind,
    refId: ref.refId,
    category: "model" satisfies UsdCategory,
    detail: { usd: microToUsd(micro), ...(ref.detail ?? {}) },
  });
}
