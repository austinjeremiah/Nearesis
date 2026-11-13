'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionBar } from './section';
import { Badge } from './evidence';
import { Button, Card, EmptyState, Field, Input, Notice, Segmented, Select, Skeleton, Textarea } from './ui';
import { ApiErrorState } from './states';
import { RunStateChip, usd } from './run-parts';
import { ApiRequestError } from '@/lib/api/errors';
import { qk } from '@/lib/api/keys';
import { formatAge } from '@/lib/format';
import { investigateApi, newKey } from '@/lib/investigate/api';
import type { Budget, QuestionPreview } from '@/lib/investigate/types';

// The runtime reserves at least 32,000 tokens, 12 tool calls and USD 3 for one composer run; a lower cap is refused.
// This is a reservation ceiling, not a price: the run is charged what it uses.
const MIN_BUDGET: Budget = { tokens: 32000, toolCalls: 12, usd: 3 };
const MAX_TOOL_CALLS = 24;
const QUESTION_MAX = 4000;

export default function AskForm({ wid, initialQuestion = '' }: { wid: string; initialQuestion?: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [question, setQuestion] = useState(initialQuestion);
  const [source, setSource] = useState<'fixture' | 'live'>('live');
  const [snapshotPolicy, setSnapshotPolicy] = useState<'live' | 'pinned'>('live');
  const [priority, setPriority] = useState<'normal' | 'low'>('normal');
  const [budget, setBudget] = useState<Budget>(MIN_BUDGET);
  const [preview, setPreview] = useState<QuestionPreview | null>(null);
  // One idempotency key per distinct request: a retry after a network failure replays, an edited request is new.
  const key = useRef<string>(newKey());
  const sig = JSON.stringify([question.trim(), source, snapshotPolicy, priority, budget]);
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
    onSuccess: (p) => {
      // Keep the preview matched to the inputs that produced it.
      lastSig.current = sig;
      setPreview(p);
    },
  });
  const askM = useMutation({
    mutationFn: () => investigateApi.ask(wid, { question: question.trim(), snapshotPolicy, source, budget, priority }, key.current),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.runs(wid) });
      router.push(`/w/${wid}/runs/${r.runId}`);
    },
  });

  const q = question.trim();
  const belowMin = budget.tokens < MIN_BUDGET.tokens || budget.toolCalls < MIN_BUDGET.toolCalls || budget.usd < MIN_BUDGET.usd;
  const overMax = budget.toolCalls > MAX_TOOL_CALLS;
  const blocked = preview && !preview.canStart ? preview.blockers.map((b) => b.message).join(' ') : null;
  const disabledReason = !q ? 'Write a question first.' : q.length > QUESTION_MAX ? 'The question is too long.' : belowMin ? 'The budget is below the minimum the run reserves.' : overMax ? `At most ${MAX_TOOL_CALLS} tool calls.` : blocked ?? '';

  const num = (k: keyof Budget) => (e: React.ChangeEvent<HTMLInputElement>) => setBudget((b) => ({ ...b, [k]: Number(e.target.value) }));

  return (
    <div className="grid c2" style={{ alignItems: 'start' }}>
      <form
        className="rv-form"
        data-testid="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabledReason && !askM.isPending) askM.mutate();
        }}
      >
        <Field label="Question" required help={`${q.length} / ${QUESTION_MAX}`}>
          <Textarea data-testid="question-input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="For example: how has weekly swap volume by status changed since August?" maxLength={QUESTION_MAX + 100} />
        </Field>
        <div className="row gap4 wrap">
          <div className="col gap1">
            <span className="label">Data source</span>
            <Segmented
              ariaLabel="Data source"
              value={source}
              onChange={setSource}
              options={[
                { value: 'live', label: 'Live' },
                { value: 'fixture', label: 'Fixture' },
              ]}
            />
            <span className="tiny dim">{source === 'live' ? 'Real indexed NEAR Intents data.' : 'Development fixture data. Labelled as such on every result.'}</span>
          </div>
          <Field label="Snapshot">
            <Select
              value={snapshotPolicy}
              onChange={(e) => setSnapshotPolicy(e.target.value as 'live' | 'pinned')}
              options={[
                { value: 'live', label: 'Live (latest data)' },
                { value: 'pinned', label: 'Pinned (fixed snapshot)' },
              ]}
            />
          </Field>
          <Field label="Priority">
            <Select
              value={priority}
              onChange={(e) => setPriority(e.target.value as 'normal' | 'low')}
              options={[
                { value: 'normal', label: 'Normal' },
                { value: 'low', label: 'Low' },
              ]}
            />
          </Field>
        </div>
        <details>
          <summary className="small strong" style={{ cursor: 'pointer' }}>
            Budget reservation
          </summary>
          <div className="col gap2" style={{ marginTop: 10 }}>
            <p className="small dim">
              This caps what the run may spend. It is a ceiling that is held while the run works and released after; you are charged for what is used. The minimum is {MIN_BUDGET.tokens.toLocaleString()} tokens, {MIN_BUDGET.toolCalls} tool calls and {usd(MIN_BUDGET.usd)}.
            </p>
            <div className="rv-budget">
              <Field label="Tokens" error={budget.tokens < MIN_BUDGET.tokens ? `Minimum ${MIN_BUDGET.tokens.toLocaleString()}` : undefined}>
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

        {askM.isError && <AskError error={askM.error} />}
        {previewM.isError && <ApiErrorState error={previewM.error} onRetry={() => previewM.mutate()} />}

        <div className="row gap2 wrap">
          <Button variant="primary" type="submit" data-testid="ask-submit" pending={askM.isPending} disabled={!!disabledReason} disabledReason={disabledReason}>
            Start investigation
          </Button>
          <Button type="button" data-testid="preview-plan" pending={previewM.isPending} disabled={!q || previewM.isPending} disabledReason="Write a question first." onClick={() => previewM.mutate()}>
            Preview plan
          </Button>
          {disabledReason && q && <span className="small dim" data-testid="ask-disabled-reason">{disabledReason}</span>}
        </div>
      </form>

      <div className="col gap3">
        <PlanPreview preview={preview} pending={previewM.isPending} />
      </div>
    </div>
  );
}

function AskError({ error }: { error: unknown }) {
  if (error instanceof ApiRequestError && (error.state === 'budget_exhausted' || error.errorCode === 'BUDGET_EXCEEDED')) {
    return (
      <div data-testid="budget-refusal">
        <ApiErrorState error={error} />
      </div>
    );
  }
  return <ApiErrorState error={error} />;
}

function PlanPreview({ preview, pending }: { preview: QuestionPreview | null; pending: boolean }) {
  if (pending) return <Skeleton rows={5} />;
  if (!preview)
    return <EmptyState title="Plan preview" body="Preview shows the exact plan, budget and approval step. It makes no model call and costs nothing." />;
  return (
    <Card title="Plan preview" subtitle={preview.note} actions={<Badge tone={preview.canStart ? 'ok' : 'bad'}>{preview.canStart ? 'can start' : 'cannot start'}</Badge>}>
      <div className="col gap3" data-testid="plan-preview" data-plan-kind={preview.planKind}>
        <p className="small">
          <span className="mono">{preview.modelCalls}</span> model calls and <span className="mono">{usd(preview.spendUsd)}</span> spent by previewing.
        </p>
        {preview.blockers.map((b) => (
          <Notice key={b.reasonCode} tone="bad" title={b.reasonCode.replace(/_/g, ' ').toLowerCase()}>
            {b.message}
          </Notice>
        ))}
        {preview.plan ? (
          preview.plan.stages.map((stage, i) => (
            <div key={i} className="col gap2">
              <span className="label">Stage {i + 1}</span>
              {stage.map((t) => (
                <div key={t.task} className="rv-stage">
                  <div className="row gap2 wrap" style={{ alignItems: 'center' }}>
                    <Badge tone="ink">{t.role}</Badge>
                    <span className="strong small">{t.task}</span>
                  </div>
                  <span className="small">{t.objective}</span>
                  <span className="tiny dim mono">{t.capabilities.join(' · ')}</span>
                  <span className="tiny dim">
                    reserves {t.budget.tokens.toLocaleString()} tokens, {t.budget.toolCalls} calls, {usd(t.budget.usd)}
                  </span>
                </div>
              ))}
            </div>
          ))
        ) : (
          <Notice tone="info" title="Planned by a model">
            With the fixture source the plan is chosen by a director model when the run starts, so it cannot be shown in advance.
          </Notice>
        )}
        {preview.plan && (
          <div className="rv-stage">
            <span className="label">Then, waiting for your approval</span>
            <span className="small mono">{preview.plan.privilegedAction.kind}</span>
            <span className="tiny dim">
              network {preview.plan.privilegedAction.network} · cost limit {usd(preview.plan.privilegedAction.costLimit)} · approval {preview.plan.privilegedAction.requiresApproval ? 'required' : 'not required'}
            </span>
          </div>
        )}
        <span className="tiny dim">
          Budget requested {preview.budget.requested.tokens.toLocaleString()} tokens / {preview.budget.requested.toolCalls} calls / {usd(preview.budget.requested.usd)}; minimum {preview.budget.minimum.tokens.toLocaleString()} / {preview.budget.minimum.toolCalls} / {usd(preview.budget.minimum.usd)}.
        </span>
      </div>
    </Card>
  );
}

export function RecentRuns({ wid }: { wid: string }) {
  const runs = useQuery({ queryKey: qk.runs(wid), queryFn: () => investigateApi.runs(wid) });
  return (
    <section>
      <SectionBar title="Recent investigations" number="002" action={<Link className="link small" href={`/w/${wid}/agents`}>All runs</Link>} />
      {runs.isPending ? (
        <Skeleton rows={4} />
      ) : runs.isError ? (
        <ApiErrorState error={runs.error} onRetry={() => runs.refetch()} />
      ) : runs.data.runs.length === 0 ? (
        <EmptyState title="No investigations yet" body="Ask a question above to start the first one." />
      ) : (
        <ul className="col gap2" data-testid="recent-runs" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {runs.data.runs.slice(0, 8).map((r) => (
            <li key={r.runId} className="row gap3" style={{ alignItems: 'center', borderBottom: '1px dashed var(--line)', paddingBottom: 8 }}>
              <RunStateChip state={r.state} />
              <Link className="link small grow" href={`/w/${wid}/runs/${r.runId}`}>
                {r.questionSummary}
                <span className="tiny dim mono"> {r.runId.slice(0, 8)}</span>
              </Link>
              <span className="tiny dim mono">{formatAge(r.startedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
