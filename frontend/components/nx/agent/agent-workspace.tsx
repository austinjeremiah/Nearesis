'use client';

import Link from 'next/link';
import './agent.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { PanelRightClose, PanelRightOpen, Receipt } from 'lucide-react';
import { Button, Notice, Segmented } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { Skeleton } from '@/components/nx/ui';
import { browserApi } from '@/lib/api/browser';
import { qk } from '@/lib/api/keys';
import { creditsApi, creditsKey } from '@/lib/near/api';
import { reportExhaustedOnLoad } from '@/lib/credits/refusal';
import { useWorkspaceStream } from '@/lib/sse/hub';
import { agentApi, agentKeys, isUnavailable } from '@/lib/agent/api';
import { loadPrefs, savePrefs } from '@/lib/agent/prefs';
import type { Selection } from '@/lib/agent/selection';
import { focusTask, needsPolling, pollDelay, pollReducer, stepLine, taskLive, type PollState } from '@/lib/agent/tasks';
import type { Thread, ThreadDetail } from '@/lib/agent/thread';
import { investigateApi } from '@/lib/investigate/api';
import AskComposer from './ask-composer';
import CanvasZone, { type AnswerGroup } from './canvas-zone';
import CostsDrawer from './costs-drawer';
import { MessageView } from './messages';
import OpsStrip from './ops-strip';
import RunCard from './run-card';
import ThreadsRail from './threads-rail';
import WsManage from './ws-manage';

export const EXAMPLES = [
  'How has NEAR Intents swap volume changed over the last 90 days?',
  'Which chain pairs carry the most NEAR Intents volume, and how concentrated is it?',
  'Create a workspace on NEAR Intents refunds, investigate it and build a PDF report.',
  'List my workspaces and their pending approvals.',
];

type LocalRun = { wid: string; runId: string; question: string };

/**
 * The agentic workspace: threads and the workspace switcher on the left, the canvas of charts in the middle, the agent
 * chat on the right. Conversations and tasks live on the server; the page only polls the open thread.
 */
export default function AgentWorkspace({ initialQuestion }: { initialQuestion: string | null }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [wid, setWid] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'chat' | 'ask'>('chat');
  const [sel, setSel] = useState<Selection>(null);
  const [pane, setPane] = useState<'rail' | 'charts' | 'chat'>('chat');
  const [chatOpen, setChatOpen] = useState(true);
  const [costsOpen, setCostsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [localRuns, setLocalRuns] = useState<LocalRun[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const consumed = useRef<string | null>(null);
  const poll = useRef<PollState>({ failures: 0, lastOkAt: null });

  // Opening /agent with the credits already used shows the request popup once; it stays closed after a dismissal.
  const creditsOnLoad = useQuery({ queryKey: creditsKey, queryFn: () => creditsApi.get(), retry: false, staleTime: 30_000 });
  const exhaustedOnLoad = creditsOnLoad.data?.exhausted === true;
  useEffect(() => {
    if (exhaustedOnLoad && creditsOnLoad.data) {
      const c = creditsOnLoad.data;
      reportExhaustedOnLoad({ allowanceUsd: c.allowanceUsd, availableUsd: c.availableUsd, contactEmail: c.contactEmail });
    }
  }, [exhaustedOnLoad, creditsOnLoad.data]);

  useEffect(() => {
    const p = loadPrefs();
    setThreadId(p.threadId);
    setWid(p.workspaceId);
    setReady(true);
  }, []);
  useEffect(() => {
    if (ready) savePrefs({ threadId, workspaceId: wid });
  }, [ready, threadId, wid]);

  /* ----------------------------------------------------------------------------- the open thread, polled */
  const detail = useQuery({
    queryKey: agentKeys.thread(threadId ?? ''),
    enabled: !!threadId,
    queryFn: async ({ signal }): Promise<ThreadDetail> => {
      try {
        const d = await agentApi.thread(threadId!, signal);
        poll.current = pollReducer(poll.current, { type: 'ok', at: Date.now() });
        return d;
      } catch (e) {
        poll.current = pollReducer(poll.current, { type: 'error' });
        throw e;
      }
    },
    retry: false,
    refetchInterval: (q) => pollDelay(q.state.data, poll.current.failures),
  });
  const d = detail.data;
  const polling = needsPolling(d);
  const failures = detail.isError && !!d ? poll.current.failures : 0;
  // A thread that is gone (deleted elsewhere, or not this user's) is forgotten rather than shown as an error.
  useEffect(() => {
    if (detail.isError && !d && isUnavailable(detail.error)) setThreadId(null);
  }, [detail.isError, detail.error, d]);
  // The list shows the newest preview and the active-task dot: refresh it when polling stops.
  const wasPolling = useRef(false);
  useEffect(() => {
    if (wasPolling.current && !polling) void qc.invalidateQueries({ queryKey: agentKeys.threads });
    wasPolling.current = polling;
  }, [polling, qc]);

  const tasks = useMemo(() => d?.tasks ?? [], [d]);
  const task = useMemo(() => focusTask(tasks), [tasks]);
  const liveTask = task && taskLive(task) ? task : null;

  // A thread remembers its workspace; opening it selects that workspace.
  const threadWs = d?.thread.workspaceId ?? null;
  const seenThread = useRef<string | null>(null);
  useEffect(() => {
    if (threadId && d && seenThread.current !== threadId) {
      seenThread.current = threadId;
      if (threadWs) setWid(threadWs);
    }
  }, [threadId, d, threadWs]);
  // A task that creates or binds a workspace moves the canvas to it.
  const taskWs = task?.links.workspaceId ?? null;
  const seenTaskWs = useRef<string | null>(null);
  useEffect(() => {
    if (taskWs && seenTaskWs.current !== `${task?.id}:${taskWs}`) {
      seenTaskWs.current = `${task?.id}:${taskWs}`;
      setWid(taskWs);
      void qc.invalidateQueries({ queryKey: qk.workspaces });
    }
  }, [taskWs, task?.id, qc]);

  const workspaces = useQuery({ queryKey: qk.workspaces, queryFn: () => browserApi.workspaces() });
  const wsList = workspaces.data?.workspaces ?? [];
  const wsObjective = wsList.find((w) => w.id === wid)?.objective ?? null;
  useEffect(() => {
    if (workspaces.isSuccess && wid && !wsList.some((w) => w.id === wid)) setWid(null);
  }, [workspaces.isSuccess, wid, wsList]);
  useWorkspaceStream(wid);

  /* ----------------------------------------------------------------------------- canvas inputs */
  const runsQ = useQuery({
    queryKey: wid ? qk.runs(wid) : ['agent', 'noruns'],
    queryFn: () => investigateApi.runs(wid!),
    enabled: !!wid,
    refetchInterval: liveTask ? 8000 : false,
    retry: false,
  });
  const latestRun = [...(runsQ.data?.runs ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.runId ?? null;
  const runIds = useMemo(() => {
    const ids = localRuns.filter((r) => r.wid === wid).map((r) => r.runId);
    if (latestRun) ids.push(latestRun);
    return [...new Set(ids)];
  }, [localRuns, wid, latestRun]);
  const groups: AnswerGroup[] = useMemo(() => {
    const out: AnswerGroup[] = [];
    let q = '';
    for (const m of d?.messages ?? []) {
      if (m.role === 'user') q = m.text ?? '';
      else if (m.kind === 'answer' && m.answer && m.state === 'ready') out.push({ turnId: m.id, question: q, answer: m.answer });
    }
    return out;
  }, [d]);

  /* ----------------------------------------------------------------------------- actions */
  const send = useMutation({
    mutationFn: async (text: string) => {
      let id = threadId;
      let created: Thread | null = null;
      if (!id) {
        created = await agentApi.createThread({ workspaceId: wid });
        id = created.id;
      }
      const r = await agentApi.send(id, { text, workspaceId: wid });
      return { id, created, ...r };
    },
    onSuccess: ({ id, created, userMessage, reply }) => {
      qc.setQueryData<ThreadDetail>(agentKeys.thread(id), (old) => ({
        thread: old?.thread ?? created ?? { id, title: 'New conversation', workspaceId: wid, updatedAt: null, preview: '', activeTaskId: null },
        messages: [...(old?.messages ?? []), userMessage, reply],
        tasks: old?.tasks ?? [],
      }));
      poll.current = { failures: 0, lastOkAt: poll.current.lastOkAt };
      setThreadId(id);
      setDraft('');
      void qc.invalidateQueries({ queryKey: agentKeys.threads });
      // A first poll right away, then the interval takes over.
      setTimeout(() => void qc.invalidateQueries({ queryKey: agentKeys.thread(id) }), 600);
    },
  });
  const newThread = useMutation({
    mutationFn: () => agentApi.createThread({ workspaceId: wid }),
    onSuccess: (t) => {
      setThreadId(t.id);
      setSel(null);
      setPane('chat');
      void qc.invalidateQueries({ queryKey: agentKeys.threads });
    },
  });
  const selectWorkspace = useCallback(
    (id: string | null) => {
      setWid(id);
      setSel(null);
      if (!id) setMode('chat');
      if (threadId) void agentApi.patchThread(threadId, { workspaceId: id }).then(() => qc.invalidateQueries({ queryKey: agentKeys.threads })).catch(() => undefined);
    },
    [threadId, qc],
  );
  const openThread = (id: string) => {
    setThreadId(id);
    setSel(null);
    setLocalRuns([]);
    setPane('chat');
  };
  const showRun = useCallback((workspaceId: string, runId: string, question: string) => {
    setLocalRuns((rs) => (rs.some((r) => r.runId === runId) ? rs : [...rs, { wid: workspaceId, runId, question }]));
    setMode('chat');
    setPane('chat');
  }, []);

  // The hero box on Home sends `q`: open a fresh thread and put the question in the composer, then drop it from the URL.
  useEffect(() => {
    if (!ready || !initialQuestion || consumed.current === initialQuestion) return;
    consumed.current = initialQuestion;
    router.replace('/agent', { scroll: false });
    setDraft(initialQuestion);
    setMode('chat');
    newThread.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, initialQuestion, router]);

  const stepKey = liveTask ? `${liveTask.id}:${liveTask.steps.find((s) => s.state === 'running' || s.state === 'waiting_user')?.idx}` : '';
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [d?.messages.length, localRuns.length, stepKey]);
  useEffect(() => {
    const k = sel?.type === 'chart' ? sel.id : sel?.type === 'finding' ? sel.charts[0] : null;
    if (k) document.getElementById(`chart-${k}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [sel]);

  const submit = (text: string) => {
    const t = text.trim().slice(0, 2000);
    if (t && !send.isPending) send.mutate(t);
  };
  const hasText = draft.trim().length > 0;
  const line = liveTask ? stepLine(liveTask) : null;
  const empty = !!d && d.messages.length === 0 && localRuns.length === 0;

  return (
    <div className="ag-page" data-testid="agent-page" data-chat={chatOpen ? 'open' : 'closed'} data-pane={pane}>
      <div className="ag-switch" role="tablist" aria-label="Agent view">
        <button type="button" role="tab" aria-selected={pane === 'rail'} onClick={() => setPane('rail')}>Threads</button>
        <button type="button" role="tab" aria-selected={pane === 'charts'} onClick={() => setPane('charts')}>Charts</button>
        <button type="button" role="tab" aria-selected={pane === 'chat'} onClick={() => setPane('chat')}>Chat</button>
      </div>

      <div className="ag-zone ag-zone-rail">
        <ThreadsRail
          threadId={threadId}
          onSelectThread={openThread}
          onNewThread={() => newThread.mutate()}
          onThreadDeleted={(id) => id === threadId && (setThreadId(null), setLocalRuns([]))}
          creatingThread={newThread.isPending}
          wid={wid}
          onSelectWorkspace={selectWorkspace}
          onManage={() => setManageOpen(true)}
        />
      </div>

      <div className="ag-zone ag-zone-canvas">
        <div className="ag-zone-head">
          <h1 className="ag-title">Agent</h1>
          <span className="small dim grow">Charts from the selected workspace and every answer</span>
          {!chatOpen && (
            <button type="button" className="btn" onClick={() => setChatOpen(true)} data-testid="agent-chat-open" style={{ padding: '0 var(--s3)', border: '1px solid var(--line-hard)' }}>
              <PanelRightOpen size={14} /> Open chat
            </button>
          )}
        </div>
        <div className="ag-zone-scroll">
          <CanvasZone groups={groups} wid={wid} objective={wsObjective ?? undefined} runIds={runIds} sel={sel} onSelect={setSel} />
        </div>
      </div>

      <aside className="ag-zone ag-zone-chat" aria-label="Agent chat" data-testid="agent-chat">
        <div className="ag-zone-head">
          <h2 className="ag-title">{d?.thread.title && threadId ? d.thread.title : 'Agent chat'}</h2>
          <span className="grow" />
          <Button variant="ghost" onClick={() => setCostsOpen(true)} data-testid="agent-costs-open"><Receipt size={14} /> Costs</Button>
          <button type="button" className="ag-iconbtn" onClick={() => setChatOpen(false)} aria-label="Collapse the chat" title="Collapse the chat">
            <PanelRightClose size={16} />
          </button>
        </div>
        <OpsStrip taskLine={line} taskWaiting={liveTask?.state === 'waiting_user'} />

        <div className="ag-log" role="log" aria-live="off" aria-label="Conversation with the agent" data-testid="agent-log">
          {threadId && detail.isPending && <Skeleton rows={4} />}
          {detail.isError && !d && (isUnavailable(detail.error) ? null : <ApiErrorState error={detail.error} onRetry={() => detail.refetch()} />)}
          {failures > 0 && (
            <Notice tone="warn" title="Live updates are delayed">
              The last refresh failed; retrying with back-off. The task keeps running on the server.
            </Notice>
          )}
          {(!threadId || empty) && (
            <div className="ag-empty" data-testid="agent-empty">
              <h3>What do you want to do on NEAR?</h3>
              <p className="small dim" style={{ margin: 0 }}>
                Ask for a quick grounded answer, or ask the agent to do the work: it proposes a plan with its cost, you tick what it may spend or publish, then you watch every step. Nothing runs until you press Start.
              </p>
              <div className="ag-chips" aria-label="Examples">
                {EXAMPLES.map((e) => (
                  <button key={e} type="button" className="ag-chip" onClick={() => submit(e)} data-testid="agent-example">
                    {e}
                  </button>
                ))}
                <Link className="ag-chip" href="/thesis">
                  Read the NEAR thesis
                </Link>
              </div>
            </div>
          )}
          {d?.messages.map((m) => (
            <MessageView key={m.id} m={m} tasks={tasks} sel={sel} onSelect={setSel} />
          ))}
          {localRuns.map((r) => (
            <div key={r.runId} className="col gap2">
              <div className="ag-user" data-testid="agent-user-turn">
                <span className="ag-user-k">You, in a workspace</span>
                {r.question}
              </div>
              <RunCard wid={r.wid} runId={r.runId} sel={sel} onSelect={setSel} />
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <div className="ag-composer-wrap">
          {wid && (
            <div className="ag-modebar">
              <Segmented ariaLabel="Composer mode" value={mode} onChange={setMode} options={[{ value: 'chat', label: 'Ask the agent' }, { value: 'ask', label: 'Ask in this workspace' }]} />
            </div>
          )}
          {mode === 'ask' && wid ? (
            <div className="ag-askwrap">
              <AskComposer key={wid} wid={wid} initialQuestion={draft} onStarted={(runId, q) => showRun(wid, runId, q)} />
            </div>
          ) : (
            <form
              className="ag-composer"
              onSubmit={(e) => {
                e.preventDefault();
                submit(draft);
              }}
            >
              {send.isError && <ApiErrorState error={send.error} onRetry={() => submit(draft)} />}
              <label htmlFor="agent-q" className="sr-only">Message the agent</label>
              <textarea
                id="agent-q"
                data-testid="agent-composer"
                rows={2}
                maxLength={2000}
                placeholder={wid ? 'Ask, or tell the agent what to do in this workspace…' : 'Ask anything about NEAR, or tell the agent what to do…'}
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
                <Button type="submit" variant="primary" pending={send.isPending} disabled={!hasText} disabledReason="Type a message first." data-testid="agent-ask">
                  Send
                </Button>
                <span className="ag-composer-hint">
                  {wid ? 'Messages use the selected workspace. ' : 'No workspace selected: quick answers only, or ask for one to be created. '}Enter to send, Shift+Enter for a new line.
                </span>
              </div>
            </form>
          )}
        </div>
      </aside>

      <CostsDrawer open={costsOpen} onOpenChange={setCostsOpen} threadId={threadId} />
      {wid && <WsManage open={manageOpen} onOpenChange={setManageOpen} wid={wid} objective={wsObjective} onShowRun={(runId, q) => showRun(wid, runId, q)} />}
    </div>
  );
}
