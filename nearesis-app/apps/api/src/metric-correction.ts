import { randomUUID } from "node:crypto";
import { historyService } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";

/** Kernel-side effects of a V18 metric correction (authored metric deprecated with `correction: true`). */
export interface MetricCorrectionInput {
  session: Session;
  workspaceId: string;
  metricKey: string;
  version: number;
  reason: string;
}

export interface MetricCorrectionOutcome {
  /** `graph/semantic-changes`: the evidence nodes flagged for recheck (their pins no longer match). */
  semanticChange: { toVersion: string; flaggedCount: number };
  /** `monitor.rule_disable`: enabled rules whose condition reads the corrected metric. */
  disabledRules: string[];
  /** A rule that could not be disabled stays enabled and is reported; the correction is never silently partial. */
  failedRules: Array<{ ruleId: string; error: string }>;
}

export type MetricCorrectionPort = (input: MetricCorrectionInput) => Promise<MetricCorrectionOutcome>;

/** The version string a corrected metric is pinned to: it equals no version any node was written against. */
export const correctedVersion = (version: number): string => `corrected:${version}`;

/**
 * Turns a correction into kernel state. (1) Records a semantic version change for the metric so every evidence node pinned
 * to it is flagged for recheck and its summaries go stale (impact analysis, W17). (2) Disables every enabled monitor rule
 * whose condition references the metric through the real `monitor.rule_disable` command, so the scheduler records
 * `skipped_disabled` and creates no task from a deprecated definition.
 */
export function createMetricCorrectionPort(kernel: Kernel): MetricCorrectionPort {
  const history = historyService(kernel);
  return async ({ session, workspaceId, metricKey, version, reason }) => {
    const toVersion = correctedVersion(version);
    const ws0 = await kernel.workspaces.get(session, workspaceId);
    const impact = await history.graphOps.changeSemanticVersion(session, workspaceId, {
      metricId: metricKey,
      toVersion,
      expectedVersion: ws0.version,
    });
    const rules = await kernel.db.tx({ orgId: session.principal.orgId, userId: session.userId }, async (tx) =>
      tx.query<{ id: string }>(
        `SELECT id FROM monitor_rules
          WHERE workspace_id = $1 AND enabled
            AND jsonb_path_exists(condition_json, '$.** ? (@.metricId == $k)', jsonb_build_object('k', $2::text))
          ORDER BY created_at, id`,
        [workspaceId, metricKey],
      ),
    );
    const disabledRules: string[] = [];
    const failedRules: MetricCorrectionOutcome["failedRules"] = [];
    for (const r of rules.rows) {
      try {
        const w = await kernel.workspaces.get(session, workspaceId);
        await kernel.commands.execute(
          session,
          workspaceId,
          {
            apiVersion: "v1",
            commandId: randomUUID(),
            commandType: "monitor.rule_disable",
            payload: { ruleId: r.id },
            expectedVersion: w.version,
          },
          { traceId: `metric-correction-${metricKey}-${version}` },
        );
        disabledRules.push(r.id);
      } catch (e) {
        failedRules.push({ ruleId: r.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    void reason;
    return {
      semanticChange: { toVersion, flaggedCount: impact.result.flaggedCount },
      disabledRules,
      failedRules,
    };
  };
}
