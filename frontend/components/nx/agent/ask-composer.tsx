'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, Notice, Segmented, Select, Textarea } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { PlanPreview } from '@/components/nx/ask-form';
import { usd } from '@/components/nx/run-parts';
import { ApiRequestError } from '@/lib/api/errors';
import { qk } from '@/lib/api/keys';
import { investigateApi, newKey } from '@/lib/investigate/api';
import { MIN_BUDGET } from '@/lib/investigate/budget';
import type { Budget, QuestionPreview } from '@/lib/investigate/types';

const MAX_TOOL_CALLS = 24;
const QUESTION_MAX = 4000;

/**
 * "Ask in this workspace": the Investigate form (source, snapshot, budget, plan preview) inside the Agent tab. A started
 * run is handed to the page, which shows the same run view as Investigate in the chat and its panels in the canvas.
 */
export default function AskComposer({ wid, initialQuestion = '', onStarted }: { wid: string; initialQuestion?: string; onStarted: (runId: string, question: string) => void }) {
  const qc = useQueryClient();
  const [question, setQuestion] = useState(initialQuestion);
  const [source, setSource] = useState<'fixture' | 'live'>('live');
  const [snapshotPolicy, setSnapshotPolicy] = useState<'live' | 'pinned'>('live');
  const [budget, setBudget] = useState<Budget>(MIN_BUDGET);
  const [preview, setPreview] = useState<QuestionPreview | null>(null);
  const key = useRef(newKey());
  const sig = JSON.stringify([wid, question.trim(), source, snapshotPolicy, budget]);
  const lastSig = useRef(sig);
  useEffect(() => {
    if (lastSig.current !== sig) {
      lastSig.current = sig;
      key.current = newKey();
      setPreview(null);
    }
  }, [sig]);

  const previewM = useMutation({
    mutationFn: () => investigateApi.preview(wid, { question: question.trim(), source, budget }),
    onSuccess: (p) => ((lastSig.current = sig), setPreview(p)),
  });
  const askM = useMutation({
    mutationFn: () => investigateApi.ask(wid, { question: question.trim(), snapshotPolicy, source, budget }, key.current),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.runs(wid) });
      onStarted(r.runId, question.trim());
      setQuestion('');
    },
  });

  const q = question.trim();
  const belowMin = budget.tokens < MIN_BUDGET.tokens || budget.toolCalls < MIN_BUDGET.toolCalls || budget.usd < MIN_BUDGET.usd;
  const overMax = budget.toolCalls > MAX_TOOL_CALLS;
  const blocked = preview && !preview.canStart ? preview.blockers.map((b) => b.message).join(' ') : null;
  const reason = !q ? 'Write a question first.' : q.length > QUESTION_MAX ? 'The question is too long.' : belowMin ? 'The budget is below the minimum the run reserves.' : overMax ? `At most ${MAX_TOOL_CALLS} tool calls.` : (blocked ?? '');
  const num = (k: keyof Budget) => (e: React.ChangeEvent<HTMLInputElement>) => setBudget((b) => ({ ...b, [k]: Number(e.target.value) }));

  return (
    <form
      className="ag-askform"
      data-testid="agent-ask-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason && !askM.isPending) askM.mutate();
      }}
    >
      <Field label="Question for this workspace" required help={`${q.length} / ${QUESTION_MAX}`}>
        <Textarea data-testid="agent-ws-question" rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={QUESTION_MAX + 100} placeholder="How has weekly swap volume by status changed since August?" />
      </Field>
      <div className="row gap3 wrap">
        <div className="col gap1">
          <span className="label">Data source</span>
          <Segmented ariaLabel="Data source" value={source} onChange={setSource} options={[{ value: 'live', label: 'Live' }, { value: 'fixture', label: 'Fixture' }]} />
          <span className="tiny dim">{source === 'live' ? 'Real indexed NEAR Intents data.' : 'Development fixture data, labelled as such.'}</span>
        </div>
        <Field label="Snapshot">
          <Select value={snapshotPolicy} onChange={(e) => setSnapshotPolicy(e.target.value as 'live' | 'pinned')} options={[{ value: 'live', label: 'Live (latest data)' }, { value: 'pinned', label: 'Pinned (fixed snapshot)' }]} />
        </Field>
      </div>
      <details>
        <summary className="small strong" style={{ cursor: 'pointer' }}>Budget reservation</summary>
        <div className="col gap2" style={{ marginTop: 8 }}>
          <p className="small dim" style={{ margin: 0 }}>
            A ceiling held while the run works and released after; you are charged for what is used. Minimum {MIN_BUDGET.tokens.toLocaleString('en-US')} tokens, {MIN_BUDGET.toolCalls} tool calls and {usd(MIN_BUDGET.usd)}.
          </p>
          <div className="rv-budget">
            <Field label="Tokens" error={budget.tokens < MIN_BUDGET.tokens ? `Minimum ${MIN_BUDGET.tokens.toLocaleString('en-US')}` : undefined}>
              <Input type="number" inputMode="numeric" min={MIN_BUDGET.tokens} step={1000} value={budget.tokens} onChange={num('tokens')} />
            </Field>
            <Field label="Tool calls" error={budget.toolCalls < MIN_BUDGET.toolCalls ? `Minimum ${MIN_BUDGET.toolCalls}` : overMax ? `Maximum ${MAX_TOOL_CALLS}` : undefined}>
              <Input type="number" inputMode="numeric" min={MIN_BUDGET.toolCalls} max={MAX_TOOL_CALLS} value={budget.toolCalls} onChange={num('toolCalls')} />
            </Field>
            <Field label="USD cap" error={budget.usd < MIN_BUDGET.usd ? `Minimum ${usd(MIN_BUDGET.usd)}` : undefined}>
              <Input type="number" inputMode="decimal" min={MIN_BUDGET.usd} step={0.5} value={budget.usd} onChange={num('usd')} />
            </Field>
          </div>
        </div>
      </details>
      {askM.isError &&
        (askM.error instanceof ApiRequestError && (askM.error.state === 'budget_exhausted' || askM.error.errorCode === 'BUDGET_EXCEEDED') ? (
          <div data-testid="budget-refusal"><ApiErrorState error={askM.error} /></div>
        ) : (
          <ApiErrorState error={askM.error} />
        ))}
      {previewM.isError && <ApiErrorState error={previewM.error} onRetry={() => previewM.mutate()} />}
      <div className="row gap2 wrap">
        <Button variant="primary" type="submit" pending={askM.isPending} disabled={!!reason} disabledReason={reason} data-testid="agent-ws-start">Start investigation</Button>
        <Button type="button" pending={previewM.isPending} disabled={!q || previewM.isPending} disabledReason="Write a question first." onClick={() => previewM.mutate()} data-testid="agent-ws-preview">Preview plan</Button>
        {reason && q && <span className="small dim">{reason}</span>}
      </div>
      {(preview || previewM.isPending) && <PlanPreview preview={preview} pending={previewM.isPending} />}
      <Notice tone="info">It asks for your approval before any change to the canvas. Run progress appears in the chat and the panels in the canvas.</Notice>
    </form>
  );
}
