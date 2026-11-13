'use client';

import './agent.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/nx/evidence';
import { Button, Notice, Spinner } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { browserApi } from '@/lib/api/browser';
import { qk } from '@/lib/api/keys';
import { newKey } from '@/lib/api/transport';
import { agentApi, isUnavailable } from '@/lib/agent/api';
import { newPipeline, runPipeline, type PipelineDeps, type PipelineState } from '@/lib/agent/pipeline';
import { browserStorage, loadTurns, saveTurns, type Turn } from '@/lib/agent/storage';
import { buildHistory } from '@/lib/agent/types';
import { investigateApi } from '@/lib/investigate/api';
import { MIN_BUDGET } from '@/lib/investigate/budget';
import type { RunSnapshot, ApprovalSnapshot } from '@/lib/agent/pipeline';
import { AnswerBody, AnswerMeta } from './answer-card';
import { ConsentCard, PipelineCard } from './pipeline-card';

export const EXAMPLES = [
  'How has NEAR Intents swap volume changed over the last 90 days?',
  'Which chain pairs carry the most NEAR Intents volume, and how concentrated is it?',
  'How many new versus returning accounts were active on NEAR in the last 30 days?',
  'Which routes have the highest Intents refund rates?',
  'Compare daily NEAR transactions with NEAR Intents swaps since August.',
];

const realDeps: PipelineDeps = {
  createWorkspace: async (objective, key) => {
    const r = await browserApi.createWorkspace({ objective: objective.slice(0, 2000), networkScope: 'near-mainnet-read', idempotencyKey: key }, { idempotencyKey: key });
    return { workspaceId: r.workspaceId };
  },
  ask: (wid, question, key) => investigateApi.ask(wid, { question: question.slice(0, 4000), snapshotPolicy: 'live', source: 'live', budget: MIN_BUDGET }, key),
  getRun: async (runId) => (await investigateApi.run(runId)) as unknown as RunSnapshot,
  getApprovals: async (runId) => (await investigateApi.approvals(runId)) as unknown as ApprovalSnapshot,
  decide: (runId, approvalId, actionHash) => investigateApi.decide(runId, approvalId, 'approve', actionHash),
  setup: (wid, runId, key) => agentApi.setup(wid, runId, key),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
    }),
  now: () => Date.now(),
};

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return <span className="mono">{Math.max(0, Math.floor((now - since) / 1000))} s</span>;
}

type Pending = { question: string; startedAt: number };
type Failure = { question: string; error: unknown };

/**
 * The Agent tab. It lives above the tab switch (the parent keeps it mounted), so a pipeline in progress keeps polling
 * while the user looks at Overview; the pipeline state is also stored so a reload can resume from the stored ids.
 */
export default function AgentTab({ active, initialQuestion, onQuestionConsumed }: { active: boolean; initialQuestion: string | null; onQuestionConsumed: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [consent, setConsent] = useState<string | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  const running = useRef(new Map<string, AbortController>());
  const askAbort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const consumed = useRef<string | null>(null);

  useEffect(() => {
    const t = loadTurns(browserStorage());
    turnsRef.current = t;
    setTurns(t);
    setLoaded(true);
    const live = running.current;
    return () => {
      for (const c of live.values()) c.abort();
      askAbort.current?.abort();
    };
  }, []);
  useEffect(() => {
    turnsRef.current = turns;
    if (loaded) saveTurns(browserStorage(), turns);
  }, [turns, loaded]);

  const anyRunning = turns.some((t) => t.kind === 'pipeline' && t.pipeline.phase === 'running');

  const startPipeline = useCallback(
    (p: PipelineState) => {
      if (running.current.has(p.id)) return;
      const ctl = new AbortController();
      running.current.set(p.id, ctl);
      const onState = (s: PipelineState) => setTurns((ts) => ts.map((t) => (t.kind === 'pipeline' && t.pipeline.id === s.id ? { ...t, pipeline: s } : t)));
      void runPipeline(p, realDeps, onState, ctl.signal).then((final) => {
        running.current.delete(p.id);
        if (final.workspaceId) void qc.invalidateQueries({ queryKey: qk.workspaces });
        if (final.phase === 'done') router.refresh();
      });
    },
    [qc, router],
  );

  const createPipeline = (objective: string) => {
    const p = newPipeline(objective.trim(), newKey, Date.now());
    setTurns((ts) => [...ts, { id: p.id, kind: 'pipeline', pipeline: p, at: Date.now() }]);
    setConsent(null);
    startPipeline(p);
  };
  const resume = (id: string) => {
    const t = turnsRef.current.find((x) => x.kind === 'pipeline' && x.pipeline.id === id);
    if (t && t.kind === 'pipeline') startPipeline(t.pipeline);
  };

  const ask = useCallback(
    async (text: string) => {
      const question = text.trim().slice(0, 2000);
      if (!question || pending) return;
      const history = buildHistory(turnsRef.current);
      const userTurn: Turn = { id: newKey(), kind: 'user', text: question, at: Date.now() };
      setTurns((ts) => [...ts, userTurn]);
      setFailure(null);
      setDraft('');
      setPending({ question, startedAt: Date.now() });
      const ctl = new AbortController();
      askAbort.current = ctl;
      try {
        const answer = await agentApi.answer(question, history, ctl.signal);
        setTurns((ts) => [...ts, { id: newKey(), kind: 'answer', question, answer, at: Date.now() }]);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) setFailure({ question, error: e });
      } finally {
        setPending(null);
      }
    },
    [pending],
  );

  // The hero box on Overview sends `q`: answer it once, then drop it from the URL so a reload does not ask again.
  useEffect(() => {
    if (!active || !loaded || !initialQuestion || consumed.current === initialQuestion) return;
    consumed.current = initialQuestion;
    onQuestionConsumed();
    void ask(initialQuestion);
  }, [active, loaded, initialQuestion, ask, onQuestionConsumed]);

  // Keep the newest thing in view.
  useEffect(() => {
    if (active) endRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [turns.length, pending, failure, consent, active]);

  const clear = () => {
    for (const c of running.current.values()) c.abort();
    running.current.clear();
    setTurns([]);
    setFailure(null);
    setConsent(null);
  };

  const lastAnswer = useMemo(() => [...turns].reverse().find((t) => t.kind === 'answer'), [turns]);

  return (
    <div className="ag" data-testid="agent-tab">
      <div className="row gap2 wrap">
        <p className="small dim grow" style={{ margin: 0 }}>
          Ask a question and get a quick answer with charts, or have the agent create a workspace and run the whole investigation.
        </p>
        {turns.length > 0 && (
          <Button variant="ghost" onClick={clear} data-testid="agent-clear">
            Clear conversation
          </Button>
        )}
      </div>

      <div className="ag-log" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation with the agent">
        {loaded && turns.length === 0 && !pending && !failure && (
          <div className="ag-empty" data-testid="agent-empty">
            <h2>What do you want to know about NEAR?</h2>
            <p className="small dim" style={{ margin: 0 }}>
              Quick answers read certified data and draw the charts. Nothing is created in your account unless you choose &quot;Create workspace&quot;.
            </p>
            <div className="ag-chips" aria-label="Example questions">
              {EXAMPLES.map((e) => (
                <button key={e} type="button" className="ag-chip" onClick={() => void ask(e)} data-testid="agent-example">
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t) => {
          if (t.kind === 'user')
            return (
              <div key={t.id} className="ag-user" data-testid="agent-user-turn">
                <span className="ag-user-k">You</span>
                {t.text}
              </div>
            );
          if (t.kind === 'pipeline')
            return <PipelineCard key={t.id} p={t.pipeline} onResume={() => resume(t.pipeline.id)} onRetry={() => resume(t.pipeline.id)} />;
          const a = t.answer;
          return (
            <article key={t.id} className="ag-card" data-testid="agent-answer" data-status={a.status} aria-label="Answer">
              <header>
                <div className="row gap2 wrap">
                  <span className="strong">Agent</span>
                  <Badge tone={a.status === 'ok' ? 'ok' : a.status === 'partial' ? 'warn' : ''}>{a.status.replace('_', ' ')}</Badge>
                </div>
              </header>
              <AnswerBody a={a} />
              <footer className="ag-foot">
                <AnswerMeta a={a} />
                <span className="grow" />
                <Button
                  onClick={() => setConsent(a.suggestedWorkspaceObjective || t.question)}
                  disabled={anyRunning}
                  disabledReason="A workspace pipeline is still running."
                  data-testid="agent-to-workspace"
                >
                  Turn this into a workspace
                </Button>
              </footer>
            </article>
          );
        })}

        {pending && (
          <div className="ag-wait" data-testid="agent-pending" role="status">
            <Spinner size={14} />
            <span className="small">
              Reading the data and writing the answer… <Elapsed since={pending.startedAt} /> elapsed. Typical answers take under 25 s.
            </span>
          </div>
        )}

        {failure &&
          (isUnavailable(failure.error) ? (
            <Notice tone="warn" title="Quick answers are not available on this API yet">
              The server replied that POST /v1/assistant/answer does not exist ({failure.error instanceof Error ? failure.error.message : 'not found'}). Nothing was asked and nothing was charged.
            </Notice>
          ) : (
            <div data-testid="agent-error">
              <ApiErrorState error={failure.error} onRetry={() => void ask(failure.question)} />
            </div>
          ))}

        {consent !== null && (
          <ConsentCard objective={consent} onChange={setConsent} onConfirm={() => createPipeline(consent)} onCancel={() => setConsent(null)} busy={anyRunning} />
        )}
        <div ref={endRef} />
      </div>

      <div className="ag-composer-wrap">
        <form
          className="ag-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(draft);
          }}
        >
          <label htmlFor="agent-q" className="sr-only">
            Message the agent
          </label>
          <textarea
            id="agent-q"
            data-testid="agent-composer"
            rows={2}
            maxLength={2000}
            placeholder={lastAnswer ? 'Ask a follow-up, or describe a workspace to create…' : 'Ask anything about NEAR…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void ask(draft);
              }
            }}
          />
          <div className="ag-composer-actions">
            <Button type="submit" variant="primary" pending={!!pending} disabled={!draft.trim()} disabledReason="Type a question first." data-testid="agent-ask">
              Ask
            </Button>
            <Button
              type="button"
              onClick={() => setConsent(draft.trim())}
              disabled={!draft.trim()}
              disabledReason="Type what to research first."
              data-testid="agent-create"
            >
              Create workspace
            </Button>
            <span className="ag-composer-hint">Enter to ask, Shift+Enter for a new line. Create workspace asks you to confirm first.</span>
          </div>
        </form>
      </div>
    </div>
  );
}

