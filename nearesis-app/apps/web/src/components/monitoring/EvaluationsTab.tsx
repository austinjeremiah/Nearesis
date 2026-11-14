"use client";
import type { MonitoringStore } from "../../lib/monitoring/use-monitoring.ts";
import { EVAL_STATUS, fmtTime, ModeBadge } from "./shared.tsx";

/** Every evaluation the scheduler recorded, including the ones that did not run the condition and why. */
export function EvaluationsTab({ store }: { store: MonitoringStore }) {
  const rules = new Map(store.data.rules.map((r) => [r.ruleId, r.name]));
  const rows = [...store.data.evaluations].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
  if (!rows.length)
    return (
      <p className="nz-sb-meta" data-testid="evaluations-empty">
        No evaluations recorded yet.
      </p>
    );
  return (
    <div className="nz-table-wrap" data-testid="evaluations-tab">
      <table className="nz-table">
        <caption className="nz-sr-only">Rule evaluations</caption>
        <thead>
          <tr>
            <th scope="col">Evaluated</th>
            <th scope="col">Rule</th>
            <th scope="col">Watermark</th>
            <th scope="col">Mode</th>
            <th scope="col">Status</th>
            <th scope="col">Why</th>
            <th scope="col">Observed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const st = EVAL_STATUS[e.status] ?? { label: e.status, why: e.status };
            return (
              <tr
                key={e.evaluationId}
                data-testid={`eval-row-${e.evaluationId}`}
                data-status={e.status}
                data-mode={e.mode}
              >
                <td>{fmtTime(e.evaluatedAt)}</td>
                <td>
                  {rules.get(e.ruleId) ?? e.ruleId.slice(0, 8)}{" "}
                  <span className="nz-sb-meta">v{e.ruleVersion}</span>
                </td>
                <td>
                  {e.sourceId} @ {fmtTime(e.watermark)}
                </td>
                <td>
                  <ModeBadge mode={e.mode} />
                </td>
                <td data-testid="eval-status">{st.label}</td>
                <td className="nz-sb-meta" data-testid="eval-reason">
                  {st.why}
                </td>
                <td>
                  {Object.entries(e.evaluatedValue)
                    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                    .join(", ") || "none"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
