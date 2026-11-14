'use client';

import Link from 'next/link';
import './storyboard.css';
import { tidyNumberNodes } from '@/lib/prose';
import { useMemo } from 'react';
import CanvasZone, { AnswerChartCard, WorkspaceCanvas, type AnswerGroup } from '../canvas-zone';
import { chartKey, toggle, type Selection } from '@/lib/agent/selection';
import { STAGE_LABEL, STAGE_PROMISE, type Stage, type StageKind } from '@/lib/agent/storyboard';
import type { Task } from '@/lib/agent/thread';
import { FindingStoryCard, type FindingView, type Hl } from './artifacts-work';
import Storyboard, { type ScrollRequest } from './storyboard';

export type MiddleView = 'storyboard' | 'charts';

const GHOSTS: StageKind[] = ['workspace', 'investigate', 'findings', 'markers', 'monitors', 'hypothesis', 'capsule', 'proof', 'publish', 'thesis'];

/** A new conversation: the stages the agent can go through, faint, with one line on what it can do. */
function EmptyStoryboard() {
  return (
    <section className="sb sb-empty" aria-label="Storyboard" data-testid="agent-canvas-empty">
      <div className="sb-scroll">
        <header className="sb-hero">
          <h2 className="sb-hero-title">Watch the agent work, step by step</h2>
          <p className="sb-hero-lead">Ask for a quick answer, or ask the agent to take a question all the way to a published, re-checkable result. Every step shows up here as it happens.</p>
        </header>
        <ol className="sb-ghosts" aria-label="The stages a task can go through">
          {GHOSTS.map((k, i) => (
            <li key={k} className="sb-ghost" style={{ ['--i' as string]: i }}>
              <span className="sb-node" data-s="waiting" aria-hidden="true"><span className="sb-node-n">{i + 1}</span></span>
              <div>
                <h3 className="sb-stage-title">{STAGE_LABEL[k]}</h3>
                <p className="sb-note">{STAGE_PROMISE[k]}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function QuickAnswers({ groups, sel, onSelect }: { groups: AnswerGroup[]; sel: Selection; onSelect: (s: Selection) => void }) {
  const hl: Hl = useMemo(() => {
    const id = sel?.type === 'chart' ? sel.id : sel?.type === 'finding' ? (sel.charts[0] ?? null) : null;
    return { id, hover: () => undefined, pin: (cid: string) => onSelect(toggle(sel, { type: 'chart', id: cid, findings: [] })) };
  }, [sel, onSelect]);
  return (
    <div className="sb-qa" data-testid="sb-quick">
      {[...groups].reverse().map((g) => {
        const findings: FindingView[] = g.answer.findings.map((f, i) => ({
          id: `${g.turnId}#${i}`,
          statement: f.statement,
          status: f.status,
          basis: f.basis,
          skepticNotes: f.skepticNotes,
          limitations: f.limitations,
          cites: f.chartIds.map((id) => ({ id: chartKey(g.turnId, id), title: g.answer.charts.find((c) => c.id === id)?.title ?? 'Chart' })),
          facts: f.facts.length,
        }));
        const charts = [...g.answer.charts].sort((a, b) => Number(a.kind === 'table') - Number(b.kind === 'table'));
        return (
          <section key={g.turnId} className="sb-qa-group" aria-label={`Answer to: ${g.question}`} data-testid="agent-chart-group">
            <header className="sb-hero">
              <h2 className="sb-hero-title">{g.question || 'Quick answer'}</h2>
              <p className="sb-hero-meta mono"><span>quick answer</span><span>{charts.length} chart{charts.length === 1 ? '' : 's'}</span><span>{findings.length} finding{findings.length === 1 ? '' : 's'}</span></p>
            </header>
            {g.answer.summary && <p className="sb-qa-lead">{tidyNumberNodes(g.answer.summary)}</p>}
            {charts.length > 0 && (
              <div className="sb-grid sb-qa-charts">
                {charts.map((c) => (
                  <AnswerChartCard key={c.id} turnId={g.turnId} c={c} answer={g.answer} sel={sel} onSelect={onSelect} />
                ))}
              </div>
            )}
            {findings.length > 0 && (
              <div className="sb-grid sb-grid-wide">
                {findings.map((f, i) => (
                  <FindingStoryCard key={f.id} f={f} hl={hl} index={i} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The middle zone. With a task it is the storyboard. Without one it shows a quick answer's charts and findings, or the
 * bound workspace's canvas, or an empty state that previews the stages. "Charts" is the previous canvas-only view.
 */
export default function MiddleZone({
  view,
  task,
  stages,
  groups,
  wid,
  objective,
  runIds,
  sel,
  onSelect,
  activeStageId,
  onActiveStage,
  request,
}: {
  view: MiddleView;
  task: Task | null;
  stages: Stage[];
  groups: AnswerGroup[];
  wid: string | null;
  objective?: string;
  runIds: string[];
  sel: Selection;
  onSelect: (s: Selection) => void;
  activeStageId: string | null;
  onActiveStage: (id: string) => void;
  request: ScrollRequest;
}) {
  if (view === 'charts') return <div className="ag-zone-scroll"><CanvasZone groups={groups} wid={wid} objective={objective} runIds={runIds} sel={sel} onSelect={onSelect} /></div>;
  if (task) return <div className="ag-zone-scroll sb-host"><Storyboard task={task} stages={stages} wid={wid} activeStageId={activeStageId} onActiveStage={onActiveStage} request={request} /></div>;
  const withAnswers = groups.length > 0;
  if (!withAnswers && !wid) return <div className="ag-zone-scroll sb-host"><EmptyStoryboard /></div>;
  return (
    <div className="ag-zone-scroll">
      <div className="sb-qa-page" data-testid="agent-canvas">
        {withAnswers && <QuickAnswers groups={groups} sel={sel} onSelect={onSelect} />}
        {wid && (
          <div className="sb-qa-ws">
            <WorkspaceCanvas wid={wid} objective={objective} runIds={runIds} sel={sel} onSelect={onSelect} />
            {!withAnswers && <p className="sb-note">Ask the agent to do work in this workspace and each step will be laid out here. <Link className="sb-link" href={`/w/${wid}/canvas`}>Open in canvas</Link></p>}
          </div>
        )}
      </div>
    </div>
  );
}
