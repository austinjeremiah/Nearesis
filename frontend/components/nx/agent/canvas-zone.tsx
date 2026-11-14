'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useQueries } from '@tanstack/react-query';
import { Badge } from '@/components/nx/evidence';
import { ApiErrorState } from '@/components/nx/states';
import { Skeleton } from '@/components/nx/ui';
import { PanelBody, PanelFrame, layoutHeight } from '@/components/nx/panel';
import { useCanvas, usePanelProgress } from '@/lib/panel/hooks';
import { ik, investigateApi } from '@/lib/investigate/api';
import { chartHighlighted, chartKey, findingsCiting, missingCount, panelKey, runFindingKey, toggle, type Selection } from '@/lib/agent/selection';
import type { AgentAnswer, AgentChart } from '@/lib/agent/types';
import { ChartBody, ChartMeta } from './answer-card';

export type AnswerGroup = { turnId: string; question: string; answer: AgentAnswer };

/** Run findings per panel, read from the same cache the run card polls. `byPanel` maps a panel key to finding keys. */
export function useRunFindingIndex(wid: string | null, runIds: string[]) {
  const results = useQueries({
    queries: runIds.map((id) => ({
      queryKey: wid ? ik.run(wid, id) : ['agent', 'norun', id],
      queryFn: () => investigateApi.run(id),
      enabled: !!wid,
      staleTime: 5_000,
    })),
  });
  return useMemo(() => {
    const byPanel = new Map<string, string[]>();
    const cited = new Set<string>();
    for (const r of results) {
      for (const f of r.data?.findings ?? []) {
        for (const p of f.panelIds) {
          cited.add(p);
          byPanel.set(panelKey(p), [...(byPanel.get(panelKey(p)) ?? []), runFindingKey(f.id)]);
        }
      }
    }
    return { byPanel, cited };
  }, [results]);
}

function AnswerChartCard({ turnId, c, answer, sel, onSelect }: { turnId: string; c: AgentChart; answer: AgentAnswer; sel: Selection; onSelect: (s: Selection) => void }) {
  const key = chartKey(turnId, c.id);
  const hl = chartHighlighted(sel, key);
  const cites = findingsCiting(turnId, answer, c.id);
  const { missing, total } = missingCount(c);
  const select = () => onSelect(toggle(sel, { type: 'chart', id: key, findings: cites }));
  return (
    <article className="ag-chartcard" id={`chart-${key}`} data-testid="agent-chart" data-kind={c.kind} data-hl={hl ? 'true' : undefined} data-dim={sel && !hl ? 'true' : undefined} aria-label={c.title}>
      <header className="ag-chartcard-head">
        <button type="button" className="ag-chart-title" aria-pressed={hl} onClick={select} title="Select to show the findings that cite this chart">
          {c.title}
        </button>
        <Badge outline>{c.kind}</Badge>
      </header>
      <div className="ag-chartcard-body">
        <ChartBody c={c} height={230} />
      </div>
      {missing > 0 && (
        <p className="ag-note" data-testid="agent-chart-gaps">
          <Badge tone="warn">Missing data</Badge> {missing} of {total} values are missing in the source and are shown as gaps, not zero.
        </p>
      )}
      <footer className="ag-chartcard-foot">
        <ChartMeta c={c} />
        <p className="ag-meta" style={{ marginTop: 4 }}>
          <span>
            freshness <span className="mono">{c.window ? `data through ${c.window.to}` : 'not reported'}</span>
          </span>
          <span>certification <span className="mono">{c.metricVersion ? `metric ${c.metricVersion}` : 'not reported'}</span></span>
        </p>
        {cites.length > 0 && (
          <p className="ag-meta" style={{ marginTop: 4 }}>
            <span>cited by {cites.length} finding{cites.length === 1 ? '' : 's'}</span>
          </p>
        )}
      </footer>
    </article>
  );
}

function WorkspaceCanvas({ wid, objective, runIds, sel, onSelect }: { wid: string; objective?: string; runIds: string[]; sel: Selection; onSelect: (s: Selection) => void }) {
  const router = useRouter();
  const canvas = useCanvas(wid);
  const progress = usePanelProgress(wid);
  const idx = useRunFindingIndex(wid, runIds);
  const panels = canvas.data?.panels ?? [];
  const markers = canvas.data?.markers ?? [];
  const ordered = [...panels].sort((a, b) => Number(idx.cited.has(b.panelId)) - Number(idx.cited.has(a.panelId)));
  return (
    <section aria-label="Workspace canvas" data-testid="agent-ws-canvas">
      <div className="ag-group-head">
        <div className="grow">
          <p className="ag-k" style={{ margin: 0 }}>Workspace canvas</p>
          <p className="small" style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{objective ?? wid}</p>
        </div>
        <Link className="link small" href={`/w/${wid}/canvas`}>Open in canvas</Link>
      </div>
      {canvas.isPending ? (
        <Skeleton rows={4} />
      ) : canvas.isError ? (
        <ApiErrorState error={canvas.error} onRetry={() => canvas.refetch()} />
      ) : panels.length === 0 ? (
        <p className="small dim" data-testid="agent-ws-empty">
          This workspace has no panels yet. Panels from the investigation appear here once the canvas change is approved.
        </p>
      ) : (
        <div className="ag-grid">
          {ordered.map((p) => {
            const key = panelKey(p.panelId);
            const cites = idx.byPanel.get(key) ?? [];
            const hl = chartHighlighted(sel, key);
            return (
              <div key={p.panelId} className="ag-pcell" data-hl={hl ? 'true' : undefined} id={`chart-${key}`}>
                <PanelFrame
                  wid={wid}
                  panel={p}
                  dim={!!sel && !hl}
                  menuItems={[{ label: 'Open in canvas', onSelect: () => router.push(`/w/${wid}/canvas`) }]}
                  tools={
                    cites.length > 0 ? (
                      <button type="button" className="ag-ref" aria-pressed={hl} onClick={() => onSelect(toggle(sel, { type: 'chart', id: key, findings: cites }))}>
                        cited by {cites.length}
                      </button>
                    ) : undefined
                  }
                >
                  <PanelBody wid={wid} panel={p} height={Math.min(layoutHeight(p), 260)} progress={progress[p.panelId]} markers={markers.filter((m) => m.panelId === p.panelId)} />
                </PanelFrame>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * The middle zone: charts and graphs only. Workspace panels (the run's and the rest of the canvas) and every quick-answer
 * chart, grouped under the question that produced it, newest first.
 */
export default function CanvasZone({
  groups,
  wid,
  objective,
  runIds,
  sel,
  onSelect,
}: {
  groups: AnswerGroup[];
  wid: string | null;
  objective?: string;
  runIds: string[];
  sel: Selection;
  onSelect: (s: Selection) => void;
}) {
  const withCharts = groups.filter((g) => g.answer.charts.length > 0);
  const empty = !wid && withCharts.length === 0;
  return (
    <section className="ag-canvas" aria-label="Charts" data-testid="agent-canvas">
      {empty && (
        <div className="ag-canvas-empty" data-testid="agent-canvas-empty">
          <h2>Charts appear here</h2>
          <p className="small dim">
            Ask a question in the chat and every chart the agent draws lands in this area, with its source, window, coverage and caveats. If you start an investigation in a workspace, that workspace&apos;s canvas panels show here too.
          </p>
        </div>
      )}
      {wid && <WorkspaceCanvas wid={wid} objective={objective} runIds={runIds} sel={sel} onSelect={onSelect} />}
      {[...withCharts].reverse().map((g) => (
        <section key={g.turnId} aria-label={`Charts for: ${g.question}`} data-testid="agent-chart-group">
          <div className="ag-group-head">
            <div className="grow">
              <p className="ag-k" style={{ margin: 0 }}>Quick answer</p>
              <p className="small" style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{g.question}</p>
            </div>
          </div>
          <div className="ag-grid">
            {[...g.answer.charts].sort((a, b) => Number(a.kind === 'table') - Number(b.kind === 'table')).map((c) => (
              <AnswerChartCard key={c.id} turnId={g.turnId} c={c} answer={g.answer} sel={sel} onSelect={onSelect} />
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}
