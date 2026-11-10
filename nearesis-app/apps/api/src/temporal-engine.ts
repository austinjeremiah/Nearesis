import { connectClient, startInvestigation } from "@nearesis/workflow";
import type { InvestigationEngine } from "./runs.ts";

/**
 * Production engine: starts and signals investigations on Temporal through @nearesis/workflow's client exports.
 * Signal names (`approve`, `reject`, `cancel`) are the ones InvestigationWorkflow registers.
 */
export function temporalEngine(opts: { address?: string; taskQueue?: string } = {}): InvestigationEngine {
  let client: ReturnType<typeof connectClient> | undefined;
  const get = () => (client ??= connectClient(opts.address));
  return {
    async start(input) {
      return startInvestigation(await get(), input, opts.taskQueue ? { taskQueue: opts.taskQueue } : {});
    },
    async signal(workflowId, name, payload) {
      await (await get()).workflow.getHandle(workflowId).signal(name, payload);
    },
  };
}
