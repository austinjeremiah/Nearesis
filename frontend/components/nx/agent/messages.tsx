'use client';

import Link from 'next/link';
import { Badge } from '@/components/nx/evidence';
import { Button, Notice, Spinner } from '@/components/nx/ui';
import { openCreditsPopup } from '@/lib/credits/refusal';
import { elapsedSeconds, formatElapsed, formatUsdString, safeHref } from '@/lib/agent/tasks';
import type { Selection } from '@/lib/agent/selection';
import type { Task, ThreadMessage } from '@/lib/agent/thread';
import { AnswerBody } from './answer-card';
import { PlanCard, TaskTimeline, useNow } from './task-cards';

function Pending({ m }: { m: ThreadMessage }) {
  const now = useNow(true);
  return (
    <div className="ag-wait" data-testid="agent-pending" role="status">
      <Spinner size={14} />
      <span className="small">
        The agent is working on this… <span className="mono">{formatElapsed(elapsedSeconds(m.createdAt, now))}</span> elapsed. Answers can take 30 to 40 s.
      </span>
    </div>
  );
}

function MsgCost({ m }: { m: ThreadMessage }) {
  if (m.cost.modelUsd === null && m.cost.modelCalls === null) return null;
  return (
    <span className="tiny dim mono" data-testid="agent-cost">
      {formatUsdString(m.cost.modelUsd)} · {m.cost.modelCalls ?? 'unknown'} model call(s)
    </span>
  );
}

export function MessageView({ m, tasks, sel, onSelect }: { m: ThreadMessage; tasks: Task[]; sel: Selection; onSelect: (s: Selection) => void }) {
  if (m.role === 'user')
    return (
      <div className="ag-user" data-testid="agent-user-turn">
        <span className="ag-user-k">You</span>
        {m.text}
      </div>
    );
  if (m.state === 'pending') return <Pending m={m} />;
  if (m.state === 'failed' || m.error)
    return (
      <div data-testid="agent-error">
        <Notice tone="bad" title={m.error?.reasonCode ?? 'The agent could not answer'}>
          {m.error?.message ?? 'No reason was returned.'} Nothing else was changed. Ask again to retry.
          {m.error?.reasonCode === 'CREDITS_EXHAUSTED' && (
            <div style={{ marginTop: 8 }}>
              <Button variant="primary" onClick={() => openCreditsPopup()} data-testid="agent-credits-request">Request more credits</Button>
            </div>
          )}
        </Notice>
      </div>
    );
  const task = m.taskId ? tasks.find((t) => t.id === m.taskId) : undefined;

  if (m.kind === 'answer' && m.answer) {
    const a = m.answer;
    return (
      <article className="ag-card" data-testid="agent-answer" data-status={a.status} aria-label="Answer">
        <header>
          <div className="row gap2 wrap">
            <span className="strong">Agent</span>
            <Badge tone={a.status === 'ok' ? 'ok' : a.status === 'partial' ? 'warn' : ''}>{a.status.replace('_', ' ')}</Badge>
          </div>
        </header>
        <AnswerBody a={a} turnId={m.id} sel={sel} onSelect={onSelect} />
        <footer className="ag-foot">
          <MsgCost m={m} />
        </footer>
      </article>
    );
  }

  if (m.kind === 'plan') {
    if (!task)
      return (
        <Notice tone="warn" title="The plan is not available">
          {m.text ?? 'This message refers to a task the server did not return.'}
        </Notice>
      );
    return (
      <div className="col gap2">
        {m.text && <p className="ag-agent-text">{m.text}</p>}
        {task.state === 'proposed' ? <PlanCard task={task} /> : <TaskTimeline task={task} />}
        <MsgCost m={m} />
      </div>
    );
  }

  if (m.kind === 'result') {
    return (
      <article className="ag-card" data-testid="agent-result" aria-label="Result">
        <section>
          <p className="ag-k">Result</p>
          {m.text && <p className="ag-agent-text" style={{ margin: 0 }}>{m.text}</p>}
          {m.rows && m.rows.length > 0 && (
            <ul className="ag-ritems ag-rrows" data-testid="agent-result-rows">
              {m.rows.map((r, i) => {
                const href = safeHref(r.href);
                return (
                  <li key={i}>
                    <span className="dim">{r.label}</span>{' '}
                    {href ? <Link className="link" href={href}>{r.value || 'open'}</Link> : <span className="mono">{r.value}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {m.rows && m.rows.length === 0 && <p className="small dim">Nothing matched.</p>}
        </section>
        {task && (
          <section>
            <TaskTimeline task={task} />
          </section>
        )}
        <footer className="ag-foot"><MsgCost m={m} /></footer>
      </article>
    );
  }

  if (m.kind === 'notice') return <Notice tone="info">{m.text ?? ''}</Notice>;

  return (
    <div className="ag-agent" data-testid="agent-text">
      <span className="ag-user-k">Agent</span>
      <p className="ag-agent-text">{m.text ?? ''}</p>
      <MsgCost m={m} />
    </div>
  );
}
