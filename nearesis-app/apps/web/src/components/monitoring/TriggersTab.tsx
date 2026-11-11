"use client";
import type { MonitorTrigger } from "@nearesis/contracts";
import type { MonitoringStore } from "../../lib/monitoring/use-monitoring.ts";
import { fmtTime, ModeBadge } from "./shared.tsx";

const OUTCOME: Record<MonitorTrigger["outcome"], string> = {
  fired: "Fired",
  condition_false: "Condition false",
  debounced: "Debounced",
  cooldown: "In cooldown",
  frequency: "Skipped (frequency)",
  no_data: "No data",
  disabled: "Skipped (rule disabled)",
};

export function TriggersTab({ store }: { store: MonitoringStore }) {
  const rules = new Map(store.data.rules.map((r) => [r.ruleId, r.name]));
  const rows = [...store.data.triggers].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
  if (!rows.length)
    return (
      <p className="nz-sb-meta" data-testid="triggers-empty">
        No rule evaluations recorded yet.
      </p>
    );
  return (
    <div className="nz-table-wrap" data-testid="triggers-tab">
      <table className="nz-table">
        <caption className="nz-sr-only">Trigger history</caption>
        <thead>
          <tr>
            <th scope="col">Evaluated</th>
            <th scope="col">Rule</th>
            <th scope="col">Source watermark</th>
            <th scope="col">Mode</th>
            <th scope="col">Outcome</th>
            <th scope="col">Observed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr
              key={t.triggerId}
              data-testid={`trigger-row-${t.triggerId}`}
              data-mode={t.mode}
              data-outcome={t.outcome}
            >
              <td>{fmtTime(t.evaluatedAt)}</td>
              <td>{rules.get(t.ruleId) ?? t.ruleId.slice(0, 8)}</td>
              <td>
                {t.sourceId} @ {fmtTime(t.watermark)}
              </td>
              <td>
                <ModeBadge mode={t.mode} />
              </td>
              <td>{OUTCOME[t.outcome]}</td>
              <td>
                {Object.entries(t.observed)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(", ") || "none"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
