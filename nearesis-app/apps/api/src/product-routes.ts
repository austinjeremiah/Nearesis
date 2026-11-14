import type { FastifyPluginAsync } from "fastify";
import { claimRoutes } from "./claim-routes.ts";
import { hypothesisRoutes } from "./hypothesis-routes.ts";
import type { ProductDeps } from "./product-common.ts";
import { runDetailRoutes } from "./run-detail-routes.ts";
import { sourceHealthRoutes } from "./source-health-routes.ts";
import type { SourceHealthOptions } from "./source-health-routes.ts";
import { thesisRoutes } from "./thesis-routes.ts";
import { workspaceAdminRoutes } from "./workspace-admin-routes.ts";

export interface ProductRoutesOptions extends ProductDeps {
  sourceHealth?: Pick<SourceHealthOptions, "port" | "now">;
  now?: () => number;
}

/**
 * One registration for the product features that previously existed only as UI: hypotheses, claims and experiments, workspace
 * profile/templates/pins/invites/org members, run task detail, source health depth, thesis documents. Wallet approvals are NOT
 * here on purpose: nothing in this API signs or submits on behalf of a wallet.
 */
export const productRoutes: FastifyPluginAsync<ProductRoutesOptions> = async (app, opts) => {
  const deps: ProductDeps = { kernel: opts.kernel, authenticate: opts.authenticate };
  await app.register(hypothesisRoutes, deps);
  await app.register(claimRoutes, deps);
  await app.register(workspaceAdminRoutes, { ...deps, ...(opts.now ? { now: opts.now } : {}) });
  await app.register(runDetailRoutes, deps);
  await app.register(sourceHealthRoutes, { ...deps, ...(opts.sourceHealth ?? {}) });
  await app.register(thesisRoutes, deps);
};
