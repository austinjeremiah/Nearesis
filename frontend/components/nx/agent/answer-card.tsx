'use client';

import { tidyNumbers } from '@/lib/prose';
import { Badge } from '@/components/nx/evidence';
import { DataTable } from '@/components/nx/table';
import { SeriesChart } from '@/components/nx/data/charts';
import { Notice } from '@/components/nx/ui';
import { chartPoints, type AgentAnswer, type AgentChart, type AgentFinding } from '@/lib/agent/types';
import { formatUsd } from '@/lib/format';

const STATUS_TONE = { supported: 'ok', mixed: 'warn', insufficient_data: '', cannot_compute: 'bad' } as const;
const VERDICT_TONE = { holds: 'ok', weakened: 'warn', unsupported: 'bad', unavailable: '' } as const;

export function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
export function fmtCost(usd: number | null): string {
  return usd === null ? '—' : formatUsd(usd, usd > 0 && usd < 0.01 ? 4 : 2);
}

export function ChartBlock({ c }: { c: AgentChart }) {
  const label = `${c.title}${c.unit ? `, ${c.unit}` : ''}`;
  return (
    <figure className="ag-fig" data-testid="agent-chart" data-kind={c.kind}>
      <figcaption className="ag-fig-title">{c.title}</figcaption>
      {c.kind === 'table' ? (
        c.columns.length === 0 || c.rows.length === 0 ? (
          <p className="small dim">The table has no rows.</p>
        ) : (
          <DataTable
            caption={label}
            rows={c.rows}
            rowKey={(r) => r.join('|')}
            columns={c.columns.map((h, i) => ({
              key: `${i}`,
              header: h,
              render: (r: (string | null)[]) => <span className="mono">{r[i] ?? '—'}</span>,
            }))}
          />
        )
      ) : c.series.length === 0 || c.x.length === 0 ? (
        <p className="small dim">No points to draw.</p>
      ) : (
        <SeriesChart ariaLabel={label} unit={c.unit ?? undefined} kind={c.kind} height={240} series={chartPoints(c)} />
      )}
      <p className="ag-meta">
        {c.unit && <span>unit <span className="mono">{c.unit}</span></span>}
        {c.source && <span>source <span className="mono">{c.source}</span></span>}
        {c.window && <span>window <span className="mono">{c.window.from} to {c.window.to}</span></span>}
        {c.coverage && <span>coverage {c.coverage}</span>}
        {c.metricVersion && <span>metric <span className="mono">{c.metricVersion}</span></span>}
      </p>
      {c.caveats.length > 0 && (
        <ul className="ag-caveats">
          {c.caveats.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      )}
    </figure>
  );
}

export function FindingCard({ f }: { f: AgentFinding }) {
  return (
    <article className="ag-finding" data-testid="agent-finding">
      <div className="row gap2 wrap">
        <Badge tone={f.basis === 'inference' ? 'info' : ''}>{f.basis}</Badge>
        <Badge tone={STATUS_TONE[f.status]}>{f.status.replace('_', ' ')}</Badge>
        <Badge tone={VERDICT_TONE[f.skepticVerdict]} outline title="Verdict of the skeptic agent">
          skeptic: {f.skepticVerdict}
        </Badge>
        {f.chartIds.map((id) => (
          <Badge key={id} outline title="Chart this finding cites">
            {id}
          </Badge>
        ))}
      </div>
      <p>{tidyNumbers(f.statement)}</p>
      <div className="tiny dim">{f.facts.length} number(s) tied to result cells</div>
      {f.limitations.length > 0 && (
        <details>
          <summary>Limitations ({f.limitations.length})</summary>
          <ul>
            {f.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </details>
      )}
      {f.skepticNotes.length > 0 && (
        <details>
          <summary>Skeptic notes ({f.skepticNotes.length})</summary>
          <ul>
            {f.skepticNotes.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

/** One answer: the lead analysis, charts with their provenance, findings, limitations and what the agent did. */
export function AnswerBody({ a }: { a: AgentAnswer }) {
  if (a.status === 'cannot_answer') {
    return (
      <section data-testid="agent-cannot-answer">
        <Notice tone="warn" title="The data cannot answer this">
          {a.cannotAnswerReason ?? 'No reason was returned.'}
        </Notice>
      </section>
    );
  }
  const bad = a.steps.filter((s) => s.outcome !== 'ok');
  return (
    <>
      <section>
        {a.status === 'partial' && (
          <p style={{ margin: '0 0 8px' }}>
            <Badge tone="warn">partial answer</Badge>
          </p>
        )}
        {a.summary ? (
          <p className="ag-lead" data-testid="agent-summary">
            {tidyNumbers(a.summary)}
          </p>
        ) : (
          <p className="small dim" data-testid="agent-no-summary">
            No written analysis was returned: the model's paragraph is withheld unless every number in it matches the data. The charts and findings below are unaffected.
          </p>
        )}
      </section>
      {a.charts.length > 0 && (
        <section>
          <p className="ag-k">Charts</p>
          {a.charts.map((c) => (
            <ChartBlock key={c.id} c={c} />
          ))}
        </section>
      )}
      {a.findings.length > 0 && (
        <section>
          <p className="ag-k">Findings</p>
          <div className="ag-findings">
            {a.findings.map((f, i) => (
              <FindingCard key={i} f={f} />
            ))}
          </div>
        </section>
      )}
      {a.limitations.length > 0 && (
        <section>
          <p className="ag-k">Limitations</p>
          <ul className="ag-caveats" style={{ marginTop: 0 }}>
            {a.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      )}
      {a.steps.length > 0 && (
        <section>
          <p className="ag-steps-line" data-testid="agent-steps">
            <span className="strong">What the agent did:</span> {a.steps.map((s) => s.label).join(', then ')}.
            {bad.length > 0 && ` ${bad.length} step(s) did not complete (${bad.map((s) => `${s.label}: ${s.outcome.replace('_', ' ')}`).join('; ')}).`}
          </p>
        </section>
      )}
    </>
  );
}

export function AnswerMeta({ a }: { a: AgentAnswer }) {
  return (
    <span className="tiny dim mono" data-testid="agent-cost">
      {fmtCost(a.cost.usd)} · {a.cost.modelCalls ?? '—'} model call(s) · {fmtMs(a.elapsedMs)}
    </span>
  );
}
