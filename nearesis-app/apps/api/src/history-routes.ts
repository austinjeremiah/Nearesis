import type { FastifyPluginAsync } from "fastify";
import type { Kernel } from "@nearesis/kernel";

export interface HistoryRoutesOptions {
  kernel: Kernel;
}

/** Seam for history routes (branches, snapshots, timeline). Filled additively by its owner. */
export const historyRoutes: FastifyPluginAsync<HistoryRoutesOptions> = async (_app, _opts) => {
  // no routes yet
};
