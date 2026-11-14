import { randomUUID } from "node:crypto";
import { gatedSpend } from "@nearesis/contracts";
import { scopedSpendGate, type CostGovernor } from "@nearesis/agent-runtime";
import { toApplicationFailure } from "./activities.ts";

/**
 * Activities that start new work (a plan, a spawned task, a role task, a privileged action, an evidence review) are
 * AUTHORISED as one `workflow_operations` unit before they execute: a hard-stopped or limit-reached workspace stops here
 * with BUDGET_EXCEEDED (non-retryable, so the workflow surfaces it for human resolution). Every other activity
 * (bookkeeping, recording an approval, cancellation, finishing a task) is only counted: refusing those would strand a
 * stopped run, so the control plane can always wind down.
 */
export const BLOCKABLE_ACTIVITIES: ReadonlySet<string> = new Set([
  "planTask",
  "spawnTask",
  "runRoleTask",
  "executePrivilegedAction",
  "reviewEvidence",
]);

type AnyActivity = (...a: never[]) => Promise<unknown>;

export function meterActivities<T extends Record<string, AnyActivity>>(
  acts: T,
  cost: CostGovernor,
  o: { attemptId?: () => string } = {},
): T {
  const attempt = o.attemptId ?? (() => randomUUID());
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(acts)) {
    out[name] = async (...args: unknown[]) => {
      const i = args[0] as { tenantId?: unknown; workspaceId?: unknown; runId?: unknown } | undefined;
      if (typeof i?.tenantId !== "string" || typeof i.workspaceId !== "string")
        return (fn as (...a: unknown[]) => Promise<unknown>)(...args); // no workspace on the input: not attributable
      const gate = scopedSpendGate(cost, {
        tenantId: i.tenantId,
        workspaceId: i.workspaceId,
        runId: typeof i.runId === "string" ? i.runId : null,
      });
      const req = {
        key: `wfop:${name}:${attempt()}`,
        dimension: "workflow_operations",
        quantity: 1,
        detail: { activity: name },
      };
      const run = () => (fn as (...a: unknown[]) => Promise<unknown>)(...args);
      try {
        if (BLOCKABLE_ACTIVITIES.has(name))
          return await gatedSpend(gate, req, async () => ({ result: await run(), quantity: 1 }));
        const r = await run();
        await gate.observe(req).catch(() => undefined); // metering must never fail a control-plane activity
        return r;
      } catch (e) {
        throw toApplicationFailure(e);
      }
    };
  }
  return out as T;
}
