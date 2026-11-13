'use client';

import './agent.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Badge } from '@/components/nx/evidence';
import { Button, Notice, Spinner } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { browserApi } from '@/lib/api/browser';
import { qk } from '@/lib/api/keys';
import { newKey } from '@/lib/api/transport';
import { useWorkspaceStream } from '@/lib/sse/hub';
import { agentApi, isUnavailable } from '@/lib/agent/api';
import { newPipeline, runPipeline, type PipelineDeps, type PipelineState, type RunSnapshot, type ApprovalSnapshot } from '@/lib/agent/pipeline';
import { browserStorage, loadContext, loadTurns, saveContext, saveTurns, type AgentContext, type Turn } from '@/lib/agent/storage';
import type { Selection } from '@/lib/agent/selection';
import { buildHistory } from '@/lib/agent/types';
import { investigateApi } from '@/lib/investigate/api';
import { MIN_BUDGET } from '@/lib/investigate/budget';
import { usd } from '@/lib/investigate/format';
import { AnswerBody, AnswerMeta } from './answer-card';
import CanvasZone, { type AnswerGroup } from './canvas-zone';
import OpsStrip from './ops-strip';
import { ConsentCard, PipelineCard } from './pipeline-card';
import RunCard from './run-card';

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
/** What is waiting for the user's confirmation: a new pipeline, or an investigation in an existing workspace. */
type Consent = { kind: 'pipeline'; objective: string } | { kind: 'ask'; wid: string; name: string; question: string };

/**
 * The agentic workspace: the canvas of charts in the middle, the agent chat on the right. State lives here, above both
 * zones, so a running pipeline keeps going while the chat is collapsed or the narrow-screen switch shows the charts.
 */
export default function AgentWorkspace({ initialQuestion }: { initialQuestion: string | null }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [ctx, setCtx] = useState<AgentContext>('quick');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [startErr, setStartErr] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [sel, setSel] = useState<Selection>(null);
  const [pane, setPane] = useState<'charts' | 'chat'>('chat');
  const [chatOpen, setChatOpen] = useState(true);
  const turnsRef = useRef<Turn[]>([]);
  const running = useRef(new Map<string, AbortController>());
  const askAbort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const consumed = useRef<string | null>(null);

  useEffect(() => {
    const t = loadTurns(browserStorage());
    turnsRef.current = t;
    setTurns(t);
    setCtx(loadContext(browserStorage()));
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
  useEffect(() => {
    if (loaded) saveContext(browserStorage(), ctx);
  }, [ctx, loaded]);

  const workspaces = useQuery({ queryKey: qk.workspaces, queryFn: () => browserApi.workspaces() });
  const wsList = workspaces.data?.workspaces ?? [];
  // A stored workspace that no longer exists falls back to quick answers rather than pointing at nothing.
  const ctxWs = wsList.find((w) => w.id === ctx) ?? null;
  useEffect(() => {
    if (workspaces.isSuccess && ctx !== 'quick' && ctx !== 'new' && !ctxWs) setCtx('quick');
  }, [workspaces.isSuccess, ctx, ctxWs]);

  const anyRunning = turns.some((t) => t.kind === 'pipeline' && t.pipeline.phase === 'running');

  // The workspace shown in the canvas: the selected one, else the one the newest run or pipeline works in.
  const lastWs = [...turns].reverse().map((t) => (t.kind === 'pipeline' ? t.pipeline.workspaceId : t.kind === 'run' ? t.workspaceId : null)).find(Boolean) ?? null;
  const canvasWid = ctxWs?.id ?? lastWs;
  const canvasObjective = wsList.find((w) => w.id === canvasWid)?.objective ?? (turns.find((t) => t.kind === 'pipeline' && t.pipeline.workspaceId === canvasWid) as Extract<Turn, { kind: 'pipeline' }> | undefined)?.pipeline.objective;
  const runIds = useMemo(
    () =>
      turns.flatMap((t) => {
        if (t.kind === 'run' && t.workspaceId === canvasWid) return [t.runId];
        if (t.kind === 'pipeline' && t.pipeline.workspaceId === canvasWid && t.pipeline.runId) return [t.pipeline.runId];
        return [];
      }),
    [turns, canvasWid],
  );
  const groups: AnswerGroup[] = useMemo(() => turns.flatMap((t) => (t.kind === 'answer' ? [{ turnId: t.id, question: t.question, answer: t.answer }] : [])), [turns]);
  // One live stream for the workspace the canvas shows, so run, task and panel events refresh the cards.
  useWorkspaceStream(canvasWid);

  const startPipeline = useCallback(
    (p: PipelineState) => {
      if (running.current.has(p.id)) return;
      const ctl = new AbortController();
      running.current.set(p.id, ctl);
      const onState = (s: PipelineState) => setTurns((ts) => ts.map((t) => (t.kind === 'pipeline' && t.pipeline.id === s.id ? { ...t, pipeline: s } : t)));
      void runPipeline(p, realDeps, onState, ctl.signal).then((final) => {
        running.current.delete(p.id);
        if (final.workspaceId) void qc.invalidateQueries({ queryKey: qk.workspaces });
        if (final.workspaceId) void qc.invalidateQueries({ queryKey: ['ws', final.workspaceId] });
      });
    },
    [qc],
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

  const startRunInWorkspace = async (c: Extract<Consent, { kind: 'ask' }>) => {
    setStarting(true);
    setStartErr(null);
    try {
      const r = await investigateApi.ask(c.wid, { question: c.question.slice(0, 4000), snapshotPolicy: 'live', source: 'live', budget: MIN_BUDGET }, newKey());
      setTurns((ts) => [...ts, { id: newKey(), kind: 'run', workspaceId: c.wid, runId: r.runId, question: c.question, at: Date.now() }]);
      setConsent(null);
      void qc.invalidateQueries({ queryKey: qk.runs(c.wid) });
    } catch (e) {
      setStartErr(e);
    } finally {
      setStarting(false);
    }
  };

  const ask = useCallback(
    async (text: string) => {
      const question = text.trim().slice(0, 2000);
      if (!question || pending) return;
      const history = buildHistory(turnsRef.current);
      setTurns((ts) => [...ts, { id: newKey(), kind: 'user', text: question, at: Date.now() }]);
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

  // What "Ask" does depends on the context: a quick answer, or (after confirmation) an investigation or a new workspace.
  const submit = (text: string) => {
    const t = text.trim();
    if (!t) return;
    if (ctx === 'quick') return void ask(t);
    setStartErr(null);
    if (ctx === 'new') return setConsent({ kind: 'pipeline', objective: t });
    setConsent({ kind: 'ask', wid: ctx, name: ctxWs?.objective ?? ctx, question: t });
  };

  // The hero box on Home sends `q`: answer it once, then drop it from the URL so a reload does not ask again.
  useEffect(() => {
    if (!loaded || !initialQuestion || consumed.current === initialQuestion) return;
    consumed.current = initialQuestion;
    router.replace('/agent', { scroll: false });
    void ask(initialQuestion);
  }, [loaded, initialQuestion, ask, router]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [turns.length, pending, failure, consent]);
  // Selecting something in the chat brings its chart into view in the canvas.
  useEffect(() => {
    const k = sel?.type === 'chart' ? sel.id : sel?.type === 'finding' ? sel.charts[0] : null;
    if (k) document.getElementById(`chart-${k}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [sel]);

  const clear = () => {
    for (const c of running.current.values()) c.abort();
    running.current.clear();
    setTurns([]);
    setFailure(null);
    setConsent(null);
    setSel(null);
  };

  const lastAnswer = turns.some((t) => t.kind === 'answer');
  const hasText = draft.trim().length > 0;

  return (
    <div className="ag-page" data-testid="agent-page" data-chat={chatOpen ? 'open' : 'closed'} data-pane={pane}>
      <div className="ag-switch" role="tablist" aria-label="Agent view">
        <button type="button" role="tab" aria-selected={pane === 'charts'} onClick={() => setPane('charts')}>Charts</button>
        <button type="button" role="tab" aria-selected={pane === 'chat'} onClick={() => setPane('chat')}>Chat</button>
      </div>

      <div className="ag-zone ag-zone-canvas">
        <div className="ag-zone-head">
          <h1 className="ag-title">Agent</h1>
          <span className="small dim grow">Charts from every answer and investigation</span>
          {!chatOpen && (
            <button type="button" className="btn" onClick={() => setChatOpen(true)} data-testid="agent-chat-open" style={{ padding: '0 var(--s3)', border: '1px solid var(--line-hard)' }}>
              <PanelRightOpen size={14} /> Open chat
            </button>
          )}
        </div>
        <div className="ag-zone-scroll">
          <CanvasZone groups={groups} wid={canvasWid} objective={canvasObjective} runIds={runIds} sel={sel} onSelect={setSel} />
        </div>
      </div>

      <aside className="ag-zone ag-zone-chat" aria-label="Agent chat" data-testid="agent-chat">
        <div className="ag-zone-head">
          <h2 className="ag-title">Agent chat</h2>
          <span className="grow" />
          {turns.length > 0 && (
            <Button variant="ghost" onClick={clear} data-testid="agent-clear">
              Clear
            </Button>
          )}
          <button type="button" className="ag-iconbtn" onClick={() => setChatOpen(false)} aria-label="Collapse the chat" title="Collapse the chat">
            <PanelRightClose size={16} />
          </button>
        </div>
        <OpsStrip />
        <div className="ag-ctx">
          <label htmlFor="agent-ctx" className="label">Context</label>
          <select id="agent-ctx" value={ctx === 'quick' || ctx === 'new' || ctxWs ? ctx : 'quick'} onChange={(e) => (setCtx(e.target.value), setConsent(null))} data-testid="agent-context">
            <option value="quick">Quick answers (no workspace)</option>
            <option value="new">New workspace</option>
            {wsList.length > 0 && (
              <optgroup label="Existing workspaces">
                {wsList.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.objective.length > 70 ? `${w.objective.slice(0, 70)}…` : w.objective}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <div className="ag-log" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation with the agent" data-testid="agent-log">
          {loaded && turns.length === 0 && !pending && !failure && !consent && (
            <div className="ag-empty" data-testid="agent-empty">
              <h3>What do you want to know about NEAR?</h3>
              <p className="small dim" style={{ margin: 0 }}>
                Quick answers read certified data and draw the charts in the canvas. Nothing is created unless you choose a workspace or &quot;Create workspace&quot; and confirm.
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
            if (t.kind === 'run')
              return (
                <div key={t.id} className="col gap2">
                  <div className="ag-user" data-testid="agent-user-turn">
                    <span className="ag-user-k">You, in a workspace</span>
                    {t.question}
                  </div>
                  <RunCard wid={t.workspaceId} runId={t.runId} sel={sel} onSelect={setSel} />
                </div>
              );
            if (t.kind === 'pipeline')
              return (
                <div key={t.id} className="col gap2">
                  <PipelineCard p={t.pipeline} onResume={() => resume(t.pipeline.id)} onRetry={() => resume(t.pipeline.id)} />
                  {t.pipeline.workspaceId && t.pipeline.runId && <RunCard wid={t.pipeline.workspaceId} runId={t.pipeline.runId} sel={sel} onSelect={setSel} />}
                </div>
              );
            const a = t.answer;
            return (
              <article key={t.id} className="ag-card" data-testid="agent-answer" data-status={a.status} aria-label="Answer">
                <header>
                  <div className="row gap2 wrap">
                    <span className="strong">Agent</span>
                    <Badge tone={a.status === 'ok' ? 'ok' : a.status === 'partial' ? 'warn' : ''}>{a.status.replace('_', ' ')}</Badge>
                  </div>
                </header>
                <AnswerBody a={a} turnId={t.id} sel={sel} onSelect={setSel} />
                <footer className="ag-foot">
                  <AnswerMeta a={a} />
                  <span className="grow" />
                  <Button onClick={() => setConsent({ kind: 'pipeline', objective: a.suggestedWorkspaceObjective || t.question })} disabled={anyRunning} disabledReason="A workspace pipeline is still running." data-testid="agent-to-workspace">
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
                Reading the data and writing the answer… <Elapsed since={pending.startedAt} /> elapsed. Answers can take 30 to 40 s.
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

          {consent?.kind === 'pipeline' && (
            <ConsentCard objective={consent.objective} onChange={(v) => setConsent({ kind: 'pipeline', objective: v })} onConfirm={() => createPipeline(consent.objective)} onCancel={() => setConsent(null)} busy={anyRunning} />
          )}
          {consent?.kind === 'ask' && (
            <section className="ag-consent" aria-labelledby="ag-ask-h" data-testid="agent-ask-consent">
              <h3 id="ag-ask-h" className="h3" style={{ margin: 0 }}>Start an investigation in this workspace</h3>
              <p className="small" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                <span className="label">Workspace </span>{consent.name}
              </p>
              <label className="col gap1">
                <span className="label">Question (editable)</span>
                <textarea rows={3} maxLength={2000} value={consent.question} onChange={(e) => setConsent({ ...consent, question: e.target.value })} />
              </label>
              <p className="small" style={{ margin: 0 }}>
                It runs on live data and reserves up to {usd(MIN_BUDGET.usd)}, {MIN_BUDGET.tokens.toLocaleString('en-US')} tokens and {MIN_BUDGET.toolCalls} tool calls; you are charged for what it uses. It asks for your approval before any change to the canvas.
              </p>
              {startErr != null && <ApiErrorState error={startErr} />}
              <div className="row gap2 wrap">
                <Button variant="primary" pending={starting} disabled={!consent.question.trim()} disabledReason="Write a question first." onClick={() => void startRunInWorkspace(consent)} data-testid="agent-ask-confirm">
                  Start investigation
                </Button>
                <Button variant="ghost" onClick={() => setConsent(null)}>Cancel</Button>
              </div>
            </section>
          )}
          <div ref={endRef} />
        </div>

        <div className="ag-composer-wrap">
          <form
            className="ag-composer"
            onSubmit={(e) => {
              e.preventDefault();
              submit(draft);
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
                  submit(draft);
                }
              }}
            />
            <div className="ag-composer-actions">
              <Button type="submit" variant="primary" pending={!!pending} disabled={!hasText} disabledReason="Type a question first." data-testid="agent-ask">
                Ask
              </Button>
              <Button type="button" onClick={() => setConsent({ kind: 'pipeline', objective: draft.trim() })} disabled={!hasText} disabledReason="Type what to research first." data-testid="agent-create">
                Create workspace
              </Button>
              <span className="ag-composer-hint">
                {ctx === 'quick' ? 'Enter to ask, Shift+Enter for a new line.' : ctx === 'new' ? 'Ask opens the confirmation for a new workspace.' : 'Ask starts an investigation in the selected workspace after you confirm.'}
              </span>
            </div>
          </form>
        </div>
      </aside>
    </div>
  );
}
