"use client";
import type { MonitorTrigger } from "@nearesis/contracts";
import { Button } from "@nearesis/ui";
import { useState } from "react";
import type { TriggerExportRow } from "../../lib/monitoring/api.ts";
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

/** Fired counts for today (UTC), live and replay kept apart so a replay can never inflate the live figure. */
function Counters({ store }: { store: MonitoringStore }) {
  const c = store.data.counters;
  return (
    <p className="nz-sb-meta" data-testid="trigger-counters">
      Fired today{c.day ? ` (${c.day} UTC)` : ""}: <b data-testid="counter-live">{c.live}</b> LIVE ·{" "}
      <b data-testid="counter-replay">{c.replay}</b> REPLAY
    </p>
  );
}

function ExportPanel({ store }: { store: MonitoringStore }) {
  const [out, setOut] = useState<{ rows: TriggerExportRow[]; report: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <section aria-label="Export trigger history">
      <Button
        size="sm"
        data-testid="export-triggers"
        onClick={async () => {
          const r = await store.api?.exportTriggers();
          if (r?.ok) {
            setOut(r.value);
            setErr(null);
          } else setErr(r ? `${r.reasonCode}: ${r.message}` : "monitoring unavailable");
        }}
      >
        Export trigger history
      </Button>
      {err && (
        <p role="alert" className="nz-error" data-testid="export-error">
          {err}
        </p>
      )}
      {out && (
        <div data-testid="export-result">
          <p className="nz-sb-meta" data-testid="export-summary">
            {out.report.split("\n")[0]}
          </p>
          <table className="nz-table">
            <caption className="nz-sr-only">Exported rows</caption>
            <tbody>
              {out.rows.map((r) => (
                <tr
                  key={r.triggerId}
                  data-testid={`export-row-${r.triggerId}`}
                  data-mode={r.mode}
                  data-label={r.label}
                >
                  <td>{r.label}</td>
                  <td>{r.sourceId}</td>
                  <td>{r.watermark}</td>
                  <td>{r.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <a
            className="nz-chip"
            data-testid="export-download"
            download="trigger-history.csv"
            href={`data:text/plain;charset=utf-8,${encodeURIComponent(out.report)}`}
          >
            Download report
          </a>
        </div>
      )}
    </section>
  );
}

export function TriggersTab({ store }: { store: MonitoringStore }) {
  return (
    <div>
      <Counters store={store} />
      <TriggerTable store={store} />
      <ExportPanel store={store} />
    </div>
  );
}

function TriggerTable({ store }: { store: MonitoringStore }) {
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
