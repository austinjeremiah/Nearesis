"use client";
import type { RunCardModel } from "@nearesis/ui";
import { Button, runStatusLabel } from "@nearesis/ui";

export interface ReportViewProps {
  runId: string;
  title: string;
  model: RunCardModel | null;
  sourceLabel: string;
  /** True when no backend can supply this run (fixture mode): say so instead of loading forever. */
  unavailable?: boolean;
  onBack: () => void;
  onOpenPanel: (queryHash: string) => void;
}

export function reportMarkdown(title: string, m: RunCardModel, sourceLabel: string): string {
  const L: string[] = [`# ${title}`, "", `- Status: ${runStatusLabel(m.run.state)}`, `- Run: ${m.run.runId}`];
  L.push(`- Data: ${sourceLabel}`, "");
  if (m.summary) L.push("## Summary", "", m.summary, "");
  const q = m.events.filter((e) => e.kind === "query");
  if (q.length) {
    L.push("## Queries and evidence", "");
    for (const e of q)
      if (e.kind === "query")
        L.push(`- ${e.metric}: ${e.rows ?? "?"} rows, ${e.certification}, hash ${e.queryHash}`);
    L.push("");
  }
  const ab = m.events.filter((e) => e.kind === "abstention");
  if (ab.length) {
    L.push("## Abstentions (not answered)", "");
    for (const e of ab) if (e.kind === "abstention") L.push(`- ${e.metric}: ${e.reason}`);
    L.push("");
  }
  if (m.run.failure)
    L.push("## Failure", "", `${m.run.failure.reasonCode}: ${m.run.failure.humanActionNeeded ?? ""}`, "");
  return L.join("\n");
}

/** Report for one finished investigation, built only from what the backend recorded: no invented findings. */
export function ReportView({
  runId,
  title,
  model,
  sourceLabel,
  unavailable,
  onBack,
  onOpenPanel,
}: ReportViewProps) {
  const queries = model?.events.filter((e) => e.kind === "query") ?? [];
  const abstentions = model?.events.filter((e) => e.kind === "abstention") ?? [];
  const agents = model?.run.children ?? [];
  const download = () => {
    if (!model) return;
    const blob = new Blob([reportMarkdown(title, model, sourceLabel)], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `report-${runId.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <article className="nz-page" data-testid="report-page" aria-labelledby="report-title">
      <header>
        <h1 id="report-title">{title}</h1>
        {model ? (
          <p className="nz-sb-meta" data-testid="report-status">
            {runStatusLabel(model.run.state)} · {sourceLabel} · run {runId.slice(0, 8)}
          </p>
        ) : (
          <p className="nz-sb-meta" role="status" data-testid="report-loading">
            {unavailable
              ? "No report is available: this workspace has no run history (fixture mode)."
              : "Loading report from the backend…"}
          </p>
        )}
      </header>
      {model && (
        <>
          <section aria-labelledby="rep-sum">
            <h2 id="rep-sum">Summary</h2>
            <p>{model.summary ?? "The run has not finished; no summary yet."}</p>
          </section>
          <section aria-labelledby="rep-q">
            <h2 id="rep-q">Queries and evidence ({queries.length})</h2>
            {queries.length === 0 ? (
              <p className="nz-sb-meta">No queries were recorded for this run.</p>
            ) : (
              <ul>
                {queries.map((e) =>
                  e.kind === "query" ? (
                    <li key={e.id}>
                      <button type="button" className="nz-chip" onClick={() => onOpenPanel(e.queryHash)}>
                        {e.metric}
                      </button>{" "}
                      <span className="nz-tabular">
                        {e.rows ?? "?"} rows · {e.certification}
                      </span>
                    </li>
                  ) : null,
                )}
              </ul>
            )}
          </section>
          {abstentions.length > 0 && (
            <section aria-labelledby="rep-ab">
              <h2 id="rep-ab">Abstentions</h2>
              <ul>
                {abstentions.map((e) =>
                  e.kind === "abstention" ? (
                    <li key={e.id}>
                      {e.metric}: {e.reason}
                    </li>
                  ) : null,
                )}
              </ul>
            </section>
          )}
          <section aria-labelledby="rep-ag">
            <h2 id="rep-ag">Agents ({agents.length})</h2>
            {agents.length === 0 ? (
              <p className="nz-sb-meta">No child agents were spawned.</p>
            ) : (
              <ul>
                {agents.map((t) => (
                  <li key={t.taskId}>
                    {t.role} · {t.status}
                    {t.objective ? ` · ${t.objective}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {model.budget && (
            <section aria-labelledby="rep-bud">
              <h2 id="rep-bud">Budget used</h2>
              <dl className="nz-kv">
                <dt>Tokens</dt>
                <dd className="nz-tabular">
                  {model.budget.tokens.used ?? "?"} / {model.budget.tokens.total}
                </dd>
                <dt>Tool calls</dt>
                <dd className="nz-tabular">
                  {model.budget.toolCalls.used ?? "?"} / {model.budget.toolCalls.total}
                </dd>
                <dt>USD</dt>
                <dd className="nz-tabular">
                  {model.budget.usd.used ?? "?"} / {model.budget.usd.total}
                </dd>
              </dl>
            </section>
          )}
        </>
      )}
      <div className="nz-page-actions">
        <Button onClick={onBack} data-testid="back-to-canvas">
          Back to canvas
        </Button>
        <Button onClick={download} disabled={!model} data-testid="report-download">
          Download Markdown
        </Button>
        <Button onClick={() => window.print()} data-testid="report-print">
          Print
        </Button>
      </div>
    </article>
  );
}
