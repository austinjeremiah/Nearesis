import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { CONTACT_EMAIL, microToUsd } from "@nearesis/kernel";
import type { Kernel, Session, TenantContext } from "@nearesis/kernel";
import { proofRoutes } from "./proof-routes.ts";
import type { ProofRoutesOptions } from "./proof-routes.ts";
import { tenantOf, usdCreditsOf } from "./usd-credits-api.ts";

export interface CreditsRoutesOptions extends ProofRoutesOptions {
  kernel: Kernel;
  authenticate(req: FastifyRequest): Promise<Session>;
}

export const ctxOf = (s: Session): TenantContext => tenantOf(s);

/**
 * Credits: GET /v1/credits (one USD balance per user), plus the paid OutLayer proof routes (proof-routes.ts). Amounts are
 * decimal USD strings with 6 places. There are no top-ups: the allowance is granted on first use and more access is
 * requested by email.
 */
export const creditsRoutes: FastifyPluginAsync<CreditsRoutesOptions> = async (app, opts) => {
  const { kernel, authenticate } = opts;
  const credits = usdCreditsOf(kernel.db);
  const proofs = await proofRoutes(app, opts);

  // Charge any run that finished while no API process was watching (the worker runs elsewhere, or this process restarted).
  credits.reconcileRuns().catch(() => undefined);
  const timer = setInterval(() => void credits.reconcileRuns().catch(() => undefined), 60_000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  async function creditsBody(ctx: TenantContext, capsuleId?: string) {
    await credits.reconcileRuns(ctx.userId).catch(() => undefined);
    const sum = await credits.summary(ctx); // grants the allowance on first use, before the entries are read
    const [entries, est, rate] = await Promise.all([
      credits.entries(ctx, 100),
      proofs.estimateFor(ctx, capsuleId),
      (opts.nearUsdRate?.() ?? Promise.resolve(null)).catch(() => null),
    ]);
    return {
      allowanceUsd: microToUsd(sum.grantedMicro),
      spentUsd: microToUsd(sum.spentMicro),
      heldUsd: microToUsd(sum.heldMicro),
      availableUsd: microToUsd(sum.availableMicro),
      exhausted: sum.availableMicro <= 0n,
      contactEmail: CONTACT_EMAIL,
      byCategory: {
        modelUsd: microToUsd(sum.byCategoryMicro.model),
        outlayerUsd: microToUsd(sum.byCategoryMicro.outlayer),
        anchorUsd: microToUsd(sum.byCategoryMicro.anchor),
      },
      nearUsdRate: rate ? { rate: rate.rate, date: rate.date } : null,
      proofEstimateUsd: est,
      entries: entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        category: e.category,
        amountUsd: microToUsd(e.amountMicro),
        refKind: e.refKind,
        refId: e.refId,
        detail: e.detail,
        createdAt: e.createdAt,
      })),
    };
  }

  app.get<{ Querystring: { capsuleId?: string } }>("/v1/credits", async (req) => {
    const s = await authenticate(req);
    const cap = typeof req.query.capsuleId === "string" ? req.query.capsuleId.slice(0, 200) : undefined;
    return creditsBody(ctxOf(s), cap);
  });
};
