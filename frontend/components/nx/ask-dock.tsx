'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Receipt, X } from 'lucide-react';
import { ApiErrorState } from '@/components/nx/states';
import { Button, IconButton, Notice, Skeleton } from '@/components/nx/ui';
import { agentApi, agentKeys, isUnavailable } from '@/lib/agent/api';
import { savePrefs } from '@/lib/agent/prefs';
import type { Selection } from '@/lib/agent/selection';
import { focusTask, needsPolling, pollDelay, pollReducer, stepLine, taskLive, type PollState } from '@/lib/agent/tasks';
import type { Thread, ThreadDetail } from '@/lib/agent/thread';
import { ComposerCard } from '@/components/nx/agent/composer-card';
import CostsDrawer from '@/components/nx/agent/costs-drawer';
import { MessageView } from '@/components/nx/agent/messages';
import { ComposerBridgeProvider } from '@/components/nx/agent/followups';
import '@/components/nx/agent/agent.css';

const KEY = (wid: string) => `nearesis.ask.thread.${wid}`;
const read = (wid: string): string | null => {
  try {
    return localStorage.getItem(KEY(wid));
  } catch {
    return null;
  }
};
const write = (wid: string, id: string | null) => {
  try {
    if (id) localStorage.setItem(KEY(wid), id);
    else localStorage.removeItem(KEY(wid));
  } catch {
    /* blocked storage: the thread is simply not remembered */
  }
};

/**
 * The docked Ask panel, bound to one workspace. It is the Agent page chat in the upstream panel shell: the same agent
 * threads API, the same plan card, step timeline and cost lines, and the same credits. Nothing runs until the user
 * ticks the plan's consent and presses Start, exactly as on the Agent page.
 */
export function AskDock({ workspaceId, workspaceName, onClose }: { workspaceId: string; workspaceName?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [threadId, setThreadId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState('');
  const [sel, setSel] = useState<Selection>(null);
  const [costsOpen, setCostsOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const poll = useRef<PollState>({ failures: 0, lastOkAt: null });

  // The thread for this workspace: the remembered one, else the newest conversation already bound to it.
  const threads = useQuery({ queryKey: agentKeys.threads, queryFn: () => agentApi.threads(), retry: false });
  useEffect(() => {
    setReady(false);
    setThreadId(read(workspaceId));
  }, [workspaceId]);
  useEffect(() => {
    if (ready || !threads.isSuccess && !threads.isError) return;
    setReady(true);
    setThreadId((cur) => cur ?? threads.data?.find((t) => t.workspaceId === workspaceId)?.id ?? null);
  }, [ready, threads.isSuccess, threads.isError, threads.data, workspaceId]);
  useEffect(() => {
    if (ready) write(workspaceId, threadId);
  }, [ready, threadId, workspaceId]);

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
  const failures = detail.isError && !!d ? poll.current.failures : 0;
  useEffect(() => {
    if (detail.isError && !d && isUnavailable(detail.error)) setThreadId(null);
  }, [detail.isError, detail.error, d]);
  const polling = needsPolling(d);
  const wasPolling = useRef(false);
  useEffect(() => {
    if (wasPolling.current && !polling) void qc.invalidateQueries({ queryKey: agentKeys.threads });
    wasPolling.current = polling;
  }, [polling, qc]);

  const tasks = useMemo(() => d?.tasks ?? [], [d]);
  const task = useMemo(() => focusTask(tasks), [tasks]);
  const liveTask = task && taskLive(task) ? task : null;
  const line = liveTask ? stepLine(liveTask) : null;

  const send = useMutation({
    mutationFn: async (text: string) => {
      let id = threadId;
      let created: Thread | null = null;
      if (!id) {
        created = await agentApi.createThread({ workspaceId });
        id = created.id;
      }
      const r = await agentApi.send(id, { text, workspaceId });
      return { id, created, ...r };
    },
    onSuccess: ({ id, created, userMessage, reply }) => {
      qc.setQueryData<ThreadDetail>(agentKeys.thread(id), (old) => ({
        thread: old?.thread ?? created ?? { id, title: 'New conversation', workspaceId, updatedAt: null, preview: '', activeTaskId: null },
        messages: [...(old?.messages ?? []), userMessage, reply],
        tasks: old?.tasks ?? [],
      }));
      poll.current = { failures: 0, lastOkAt: poll.current.lastOkAt };
      setThreadId(id);
      setDraft('');
      void qc.invalidateQueries({ queryKey: agentKeys.threads });
      setTimeout(() => void qc.invalidateQueries({ queryKey: agentKeys.thread(id) }), 600);
    },
  });
  const submit = (text: string) => {
    const t = text.trim().slice(0, 2000);
    if (t && !send.isPending) send.mutate(t);
  };

  const stepKey = liveTask ? `${liveTask.id}:${liveTask.steps.find((s) => s.state === 'running' || s.state === 'waiting_user')?.idx}` : '';
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [d?.messages.length, stepKey]);

  const fill = useCallback((text: string) => {
    setDraft(text);
    setTimeout(() => {
      const el = document.getElementById('ask-dock-q') as HTMLTextAreaElement | null;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange?.(el.value.length, el.value.length);
      el.scrollIntoView?.({ block: 'nearest' });
    }, 30);
  }, []);
  const bridge = useMemo(() => ({ fill, workspaceId }), [fill, workspaceId]);
  const empty = !threadId || (!!d && d.messages.length === 0);

  return (
    <ComposerBridgeProvider value={bridge}>
    <aside className="askpanel" aria-label="Agent panel" data-testid="ask-dock">
      <header className="ask-head">
        <span className="label">Ask</span>
        {workspaceName && <span className="tiny dim ellipsis">{workspaceName}</span>}
        <div className="grow" />
        <Button variant="ghost" onClick={() => setCostsOpen(true)} data-testid="ask-dock-costs">
          <Receipt size={14} /> Costs
        </Button>
        <IconButton label="Close the agent panel" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>

      <div className="ask-body ag-log" role="log" aria-live="off" aria-label="Conversation with the agent">
        {threadId && detail.isPending && <Skeleton rows={4} />}
        {detail.isError && !d && (isUnavailable(detail.error) ? null : <ApiErrorState error={detail.error} onRetry={() => detail.refetch()} />)}
        {failures > 0 && (
          <Notice tone="warn" title="Live updates are delayed">
            The last refresh failed; retrying with back-off. The task keeps running on the server.
          </Notice>
        )}
        {empty && (
          <p className="small dim" data-testid="ask-dock-intro" style={{ margin: 0 }}>
            Ask a question about this workspace. You will see the plan, its cost and the measures it would read before anything runs.
          </p>
        )}
        {line && (
          <p className="tiny dim mono" data-testid="ask-dock-line" style={{ margin: 0 }}>
            {line}
          </p>
        )}
        {d?.messages.map((m) => (
          <MessageView key={m.id} m={m} tasks={tasks} sel={sel} onSelect={setSel} />
        ))}
        {threadId && (
          <Link className="link small" href="/agent" onClick={() => savePrefs({ threadId, workspaceId })}>
            Open this conversation on the Agent page
          </Link>
        )}
        <div ref={endRef} />
      </div>

      <div className="ask-foot">
        <ComposerCard
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          pending={send.isPending}
          inputId="ask-dock-q"
          placeholder="Ask a question about this workspace"
          error={send.isError ? <ApiErrorState error={send.error} onRetry={() => submit(draft)} /> : undefined}
        />
      </div>
      <CostsDrawer open={costsOpen} onOpenChange={setCostsOpen} threadId={threadId} />
    </aside>
    </ComposerBridgeProvider>
  );
}
