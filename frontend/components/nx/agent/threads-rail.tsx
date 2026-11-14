'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, MessageSquarePlus, Pencil, Trash2, Check, X, FolderPlus } from 'lucide-react';
import { Button, Spinner } from '@/components/nx/ui';
import { ConfirmDialog } from '@/components/nx/overlays';
import { ApiErrorState } from '@/components/nx/states';
import { MutationError } from '@/components/nx/research-kit';
import { browserApi } from '@/lib/api/browser';
import { qk } from '@/lib/api/keys';
import { newKey } from '@/lib/api/transport';
import { agentApi, agentKeys, isUnavailable } from '@/lib/agent/api';
import { reportPageHref, reportPdfHref } from '@/lib/agent/tasks';
import type { Thread } from '@/lib/agent/thread';
import { formatAge } from '@/lib/format';

function ThreadRow({ t, active, onOpen, onDeleted }: { t: Thread; active: boolean; onOpen: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [del, setDel] = useState(false);
  const rename = useMutation({
    mutationFn: () => agentApi.patchThread(t.id, { title: title.trim() }),
    onSuccess: () => (setEditing(false), void qc.invalidateQueries({ queryKey: agentKeys.threads })),
  });
  const remove = useMutation({
    mutationFn: () => agentApi.deleteThread(t.id),
    onSuccess: () => (setDel(false), onDeleted(), void qc.invalidateQueries({ queryKey: agentKeys.threads })),
  });
  return (
    <li className="ag-thread" data-active={active ? 'true' : undefined} data-testid="agent-thread">
      {editing ? (
        <form className="ag-thread-edit" onSubmit={(e) => (e.preventDefault(), title.trim() && rename.mutate())}>
          <label className="sr-only" htmlFor={`rn-${t.id}`}>Thread title</label>
          <input id={`rn-${t.id}`} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} />
          <button type="submit" className="ag-iconbtn" aria-label="Save title" disabled={rename.isPending || !title.trim()}><Check size={14} /></button>
          <button type="button" className="ag-iconbtn" aria-label="Cancel rename" onClick={() => setEditing(false)}><X size={14} /></button>
        </form>
      ) : (
        <>
          <button type="button" className="ag-thread-open" onClick={onOpen} aria-current={active ? 'true' : undefined}>
            <span className="ag-thread-title">{t.title}</span>
            <span className="ag-thread-sub">
              {t.activeTaskId && <span className="ag-live" title="A task is running" aria-label="task running" />}
              {t.preview ? t.preview : 'No messages'} · {formatAge(t.updatedAt)}
            </span>
          </button>
          <span className="ag-thread-actions">
            <button type="button" className="ag-iconbtn" aria-label={`Rename ${t.title}`} onClick={() => (setTitle(t.title), setEditing(true))}><Pencil size={13} /></button>
            <button type="button" className="ag-iconbtn" aria-label={`Delete ${t.title}`} onClick={() => setDel(true)}><Trash2 size={13} /></button>
          </span>
        </>
      )}
      <MutationError error={rename.error} />
      <ConfirmDialog open={del} onOpenChange={setDel} title="Delete this conversation?" body="The conversation disappears from your list. Costs it incurred stay on the ledger." confirmLabel="Delete" danger pending={remove.isPending} onConfirm={() => remove.mutate()} />
    </li>
  );
}

/** Left rail: the user's server-side threads, and the workspace switcher with create and archive. */
export default function ThreadsRail({
  threadId,
  onSelectThread,
  onNewThread,
  onThreadDeleted,
  creatingThread,
  wid,
  onSelectWorkspace,
  onManage,
}: {
  threadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onThreadDeleted: (id: string) => void;
  creatingThread: boolean;
  wid: string | null;
  onSelectWorkspace: (id: string | null) => void;
  onManage: () => void;
}) {
  const qc = useQueryClient();
  const threads = useQuery({ queryKey: agentKeys.threads, queryFn: () => agentApi.threads(), refetchInterval: 20_000, retry: false });
  const workspaces = useQuery({ queryKey: qk.workspaces, queryFn: () => browserApi.workspaces() });
  const list = workspaces.data?.workspaces ?? [];
  const sel = list.find((w) => w.id === wid) ?? null;
  const [creating, setCreating] = useState(false);
  const [objective, setObjective] = useState('');
  const [archive, setArchive] = useState(false);
  const create = useMutation({
    mutationFn: () => {
      const key = newKey();
      return browserApi.createWorkspace({ objective: objective.trim().slice(0, 2000), networkScope: 'near-mainnet-read', idempotencyKey: key }, { idempotencyKey: key });
    },
    onSuccess: (r) => {
      setCreating(false);
      setObjective('');
      void qc.invalidateQueries({ queryKey: qk.workspaces });
      onSelectWorkspace(r.workspaceId);
    },
  });
  const arch = useMutation({
    mutationFn: (id: string) => agentApi.archiveWorkspace(id),
    onSuccess: () => {
      setArchive(false);
      onSelectWorkspace(null);
      void qc.invalidateQueries({ queryKey: qk.workspaces });
    },
  });

  return (
    <nav className="ag-rail" aria-label="Conversations and workspaces" data-testid="agent-rail">
      <section className="ag-rail-sec ag-rail-threads" aria-labelledby="ag-thr-h">
        <div className="ag-rail-head">
          <h2 id="ag-thr-h" className="ag-k" style={{ margin: 0 }}>Conversations</h2>
          <button type="button" className="ag-iconbtn" onClick={onNewThread} disabled={creatingThread} aria-label="New conversation" title="New conversation" data-testid="agent-new-thread">
            {creatingThread ? <Spinner size={14} /> : <MessageSquarePlus size={16} />}
          </button>
        </div>
        {threads.isPending ? (
          <p className="small dim"><Spinner size={12} /> Loading…</p>
        ) : threads.isError ? (
          isUnavailable(threads.error) ? (
            <p className="small dim" data-testid="agent-threads-unavailable">Conversations are not available on this API yet. Nothing is stored in your browser.</p>
          ) : (
            <ApiErrorState error={threads.error} onRetry={() => threads.refetch()} />
          )
        ) : threads.data.length === 0 ? (
          <p className="small dim" data-testid="agent-threads-empty">No conversations yet. Ask something to start one.</p>
        ) : (
          <ul className="ag-threads" aria-label="Conversations">
            {threads.data.map((t) => (
              <ThreadRow key={t.id} t={t} active={t.id === threadId} onOpen={() => onSelectThread(t.id)} onDeleted={() => onThreadDeleted(t.id)} />
            ))}
          </ul>
        )}
      </section>

      <section className="ag-rail-sec ag-rail-ws" aria-labelledby="ag-ws-h" data-testid="agent-ws-switcher">
        <div className="ag-rail-head">
          <h2 id="ag-ws-h" className="ag-k" style={{ margin: 0 }}>Workspace</h2>
          <button type="button" className="ag-iconbtn" onClick={() => setCreating((c) => !c)} aria-expanded={creating} aria-label="Create a workspace" title="Create a workspace" data-testid="agent-ws-new"><FolderPlus size={16} /></button>
        </div>
        <label className="sr-only" htmlFor="agent-ws-select">Selected workspace</label>
        <select id="agent-ws-select" value={sel?.id ?? ''} onChange={(e) => onSelectWorkspace(e.target.value || null)} data-testid="agent-context">
          <option value="">None (quick answers)</option>
          {list.map((w) => (
            <option key={w.id} value={w.id}>{w.objective.length > 60 ? `${w.objective.slice(0, 60)}…` : w.objective}</option>
          ))}
        </select>
        {workspaces.isError && <ApiErrorState error={workspaces.error} onRetry={() => workspaces.refetch()} />}
        {creating && (
          <form className="col gap2" onSubmit={(e) => (e.preventDefault(), objective.trim().length >= 3 && create.mutate())} data-testid="agent-ws-create">
            <label className="col gap1">
              <span className="label">Objective</span>
              <textarea rows={3} maxLength={2000} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What should this workspace research?" />
            </label>
            <div className="row gap2">
              <Button type="submit" variant="primary" pending={create.isPending} disabled={objective.trim().length < 3} disabledReason="Describe the objective first.">Create</Button>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            </div>
            <MutationError error={create.error} />
          </form>
        )}
        {sel && (
          <div className="ag-ws-actions">
            <Button onClick={onManage} data-testid="agent-ws-manage">Manage</Button>
            <a className="btn" href={reportPdfHref(sel.id)} data-testid="agent-pdf">Download PDF report</a>
            <a className="link small" href={reportPageHref(sel.id)}>Open report</a>
            <Button variant="danger" onClick={() => setArchive(true)} data-testid="agent-ws-archive"><Archive size={13} /> Archive</Button>
          </div>
        )}
        <MutationError error={arch.error} />
        <ConfirmDialog
          open={archive}
          onOpenChange={setArchive}
          title="Archive this workspace?"
          body={`"${sel?.objective.slice(0, 120) ?? ''}" is archived and leaves your list. Its runs, findings and costs stay on record.`}
          confirmLabel="Archive workspace"
          danger
          pending={arch.isPending}
          onConfirm={() => sel && arch.mutate(sel.id)}
        />
      </section>
    </nav>
  );
}
