'use client';

import { tidyNumbers } from '@/lib/prose';
import { Badge } from '@/components/nx/evidence';
import { DataTable } from '@/components/nx/table';
import { SeriesChart } from '@/components/nx/data/charts';
import { Notice } from '@/components/nx/ui';
import { chartPoints, type AgentAnswer, type AgentChart, type AgentFinding } from '@/lib/agent/types';
import { formatUsd } from '@/lib/format';
import { answerFindingKey, chartKey, findingHighlighted, selectAnswerChart, selectAnswerFinding, toggle, type Selection } from '@/lib/agent/selection';

const STATUS_TONE = { supported: 'ok', mixed: 'warn', insufficient_data: '', cannot_compute: 'bad' } as const;
const VERDICT_TONE = { holds: 'ok', weakened: 'warn', unsupported: 'bad', unavailable: '' } as const;

export function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
export function fmtCost(usd: number | null): string {
  return usd === null ? '—' : formatUsd(usd, usd > 0 && usd < 0.01 ? 4 : 2);
}

export function ChartBody({ c, height = 240 }: { c: AgentChart; height?: number }) {
  const label = `${c.title}${c.unit ? `, ${c.unit}` : ''}`;
  if (c.kind === 'table')
    return c.columns.length === 0 || c.rows.length === 0 ? (
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
    );
  return c.series.length === 0 || c.x.length === 0 ? (
    <p className="small dim">No points to draw.</p>
  ) : (
    <SeriesChart ariaLabel={label} unit={c.unit ?? undefined} kind={c.kind} height={height} series={chartPoints(c)} />
  );
}

export function ChartMeta({ c }: { c: AgentChart }) {
  return (
    <>
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
    </>
  );
}

export function FindingCard({ f, highlighted, onSelect, onChip }: { f: AgentFinding; highlighted?: boolean; onSelect?: () => void; onChip?: (chartId: string) => void }) {
  return (
    <article className="ag-finding" data-testid="agent-finding" data-hl={highlighted ? 'true' : undefined}>
      <div className="row gap2 wrap">
        <Badge tone={f.basis === 'inference' ? 'info' : ''}>{f.basis}</Badge>
        <Badge tone={STATUS_TONE[f.status]}>{f.status.replace('_', ' ')}</Badge>
        <Badge tone={VERDICT_TONE[f.skepticVerdict]} outline title="Verdict of the skeptic agent">
          skeptic: {f.skepticVerdict}
        </Badge>
      </div>
      <p>{tidyNumbers(f.statement)}</p>
      <div className="row gap2 wrap">
        <span className="tiny dim">{f.facts.length} number(s) tied to result cells</span>
        {f.chartIds.map((id) => (
          <button key={id} type="button" className="ag-ref" onClick={() => (onChip ? onChip(id) : onSelect?.())} title="Show this chart in the canvas" data-testid="agent-chart-chip">
            chart {id}
          </button>
        ))}
        {onSelect && (
          <button type="button" className="ag-ref" aria-pressed={!!highlighted} onClick={onSelect} data-testid="agent-finding-select">
            {highlighted ? 'Clear highlight' : 'Highlight charts'}
          </button>
        )}
      </div>
      {f.limitations.length > 0 && (
        <details>
          <summary>Limitations ({f.limitations.length})</summary>
          <ul>
            {f.limitations.map((l, i) => (
              <li key={i}>{tidyNumbers(l)}</li>
            ))}
          </ul>
        </details>
      )}
      {f.skepticNotes.length > 0 && (
        <details>
          <summary>Skeptic notes ({f.skepticNotes.length})</summary>
          <ul>
            {f.skepticNotes.map((l, i) => (
              <li key={i}>{tidyNumbers(l)}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

/**
 * One answer, text parts only: the lead analysis, findings, limitations and the activity list. The charts live in the
 * canvas zone; here they are small chips that select them.
 */
export function AnswerBody({
  a,
  turnId = 'a',
  sel = null,
  onSelect,
}: {
  a: AgentAnswer;
  turnId?: string;
  sel?: Selection;
  onSelect?: (s: Selection) => void;
}) {
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
            No written analysis was returned: the model&apos;s paragraph is withheld unless every number in it matches the data. The charts and findings are unaffected.
          </p>
        )}
        {a.charts.length > 0 && (
          <div className="ag-chips-row" data-testid="agent-chart-refs">
            <span className="ag-k" style={{ margin: 0 }}>Charts in the canvas</span>
            {a.charts.map((c) => (
              <button
                key={c.id}
                type="button"
                className="ag-ref"
                aria-pressed={sel?.type === 'chart' && sel.id === chartKey(turnId, c.id)}
                onClick={() => onSelect?.(toggle(sel, selectAnswerChart(turnId, a, c.id)))}
                data-testid="agent-chart-ref"
              >
                {c.title}
              </button>
            ))}
          </div>
        )}
      </section>
      {a.findings.length > 0 && (
        <section>
          <p className="ag-k">Findings</p>
          <div className="ag-findings">
            {a.findings.map((f, i) => (
              <FindingCard
                key={i}
                f={f}
                highlighted={findingHighlighted(sel, answerFindingKey(turnId, i))}
                onSelect={() => onSelect?.(toggle(sel, selectAnswerFinding(turnId, a, i)))}
                onChip={(cid) => onSelect?.(toggle(sel, selectAnswerChart(turnId, a, cid)))}
              />
            ))}
          </div>
        </section>
      )}
      {a.limitations.length > 0 && (
        <section>
          <p className="ag-k">Limitations</p>
          <ul className="ag-caveats" style={{ marginTop: 0 }}>
            {a.limitations.map((l, i) => (
              <li key={i}>{tidyNumbers(l)}</li>
            ))}
          </ul>
        </section>
      )}
      {a.steps.length > 0 && (
        <section data-testid="agent-steps">
          <p className="ag-k">What the agent did</p>
          <ol className="ag-activity">
            {a.steps.map((s, i) => (
              <li key={i} data-outcome={s.outcome}>
                <span className="small">{s.label}</span>
                {s.outcome !== 'ok' && <Badge tone={s.outcome === 'cannot_compute' ? 'warn' : 'bad'}>{s.outcome.replace('_', ' ')}</Badge>}
                <span className="tiny dim mono">{fmtMs(s.ms)}</span>
              </li>
            ))}
          </ol>
          {bad.length > 0 && (
            <p className="tiny dim" style={{ margin: '6px 0 0' }}>
              {bad.length} step(s) did not complete: {bad.map((s) => `${s.label}: ${s.outcome.replace('_', ' ')}`).join('; ')}.
            </p>
          )}
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
