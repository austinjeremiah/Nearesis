'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { invalidationsFor, invalidationsForCoalesced, invalidationsForReload, type QueryKeyPrefix } from './invalidation';
import { WorkspaceStream, type DomainEvent, type StreamStatus } from './stream';

/**
 * SSE hub: one EventSource per workspace for this browser tab, shared by every
 * component that asks for it (reference counted, with a short grace period so
 * route changes do not tear the stream down). Events invalidate TanStack Query
 * caches in batches; components that need payloads subscribe with `useWorkspaceEvents`.
 * A stable `x-client-id` per browser is passed as `?clientId=` (EventSource cannot set headers)
 * so the API's six-streams-per-browser limit counts what it should.
 */

const FLUSH_MS = 150;
const GRACE_MS = 2000;

function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function clientId(): string {
  const s = safeStorage('local');
  const existing = s?.getItem('nx.clientId');
  if (existing && /^[A-Za-z0-9._-]{1,64}$/.test(existing)) return existing;
  const id = `nx-${(crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`;
  try {
    s?.setItem('nx.clientId', id);
  } catch {
    /* private mode: a per-load id still works */
  }
  return id;
}

type Entry = {
  wid: string;
  stream: WorkspaceStream;
  refs: number;
  status: StreamStatus;
  detail?: { reason?: string; retryInMs?: number };
  pending: Map<string, QueryKeyPrefix>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  qc: QueryClient;
  hadGap: boolean;
};

const registry = new Map<string, Entry>();
// Buses are global (keyed by workspace) so hooks can subscribe before the entry exists.
const statusListeners = new Set<() => void>();
const eventListeners = new Map<string, Set<(e: DomainEvent) => void>>();

function schedule(entry: Entry, keys: QueryKeyPrefix[]) {
  for (const k of keys) entry.pending.set(JSON.stringify(k), k);
  if (entry.flushTimer) return;
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = null;
    const batch = [...entry.pending.values()];
    entry.pending.clear();
    for (const queryKey of batch) void entry.qc.invalidateQueries({ queryKey });
  }, FLUSH_MS);
}

function create(wid: string, qc: QueryClient): Entry {
  const store = safeStorage('session');
  const stored = Number(store?.getItem(`nx.sse.${wid}`));
  const entry: Entry = {
    wid,
    refs: 0,
    status: 'idle',
    pending: new Map(),
    flushTimer: null,
    stopTimer: null,
    qc,
    hadGap: false,
    stream: null as unknown as WorkspaceStream,
  };
  const cid = clientId();
  entry.stream = new WorkspaceStream({
    workspaceId: wid,
    initialCursor: Number.isFinite(stored) && stored > 0 ? stored : null,
    buildUrl: (cursor) => `/api/events/${encodeURIComponent(wid)}?cursor=${cursor}&clientId=${encodeURIComponent(cid)}`,
    createEventSource: (url) => new EventSource(url) as unknown as ReturnType<ConstructorParameters<typeof WorkspaceStream>[0]['createEventSource']>,
    onCursor: (seq) => {
      try {
        store?.setItem(`nx.sse.${wid}`, String(seq));
      } catch {
        /* cursor persistence is an optimisation */
      }
    },
    onStatus: (status, detail) => {
      entry.status = status;
      entry.detail = detail;
      statusListeners.forEach((l) => l());
      // After a reconnect gap, anything may have changed: refresh once we are back.
      if (status === 'open' && entry.hadGap) schedule(entry, invalidationsForReload(wid));
      if (status === 'reconnecting') entry.hadGap = true;
      if (status === 'open') entry.hadGap = false;
    },
    onEvent: (e) => {
      schedule(entry, invalidationsFor(e.event, wid));
      eventListeners.get(wid)?.forEach((l) => l(e));
    },
    onCoalesced: (d) => schedule(entry, invalidationsForCoalesced(d.byType, wid)),
    onReload: () => schedule(entry, invalidationsForReload(wid)),
    checkSession: async () => {
      try {
        const r = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' });
        if (r.status === 401) {
          window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
          return false;
        }
        return r.ok;
      } catch {
        return true; // network blip, not a session problem: keep trying
      }
    },
  });
  return entry;
}

export function acquireWorkspaceStream(wid: string, qc: QueryClient): () => void {
  let entry = registry.get(wid);
  if (!entry) {
    entry = create(wid, qc);
    registry.set(wid, entry);
  }
  if (entry.stopTimer) {
    clearTimeout(entry.stopTimer);
    entry.stopTimer = null;
  }
  entry.refs += 1;
  entry.stream.start();
  const e = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    e.refs -= 1;
    if (e.refs > 0) return;
    e.stopTimer = setTimeout(() => {
      if (e.refs > 0) return;
      e.stream.stop();
      if (e.flushTimer) clearTimeout(e.flushTimer);
      registry.delete(e.wid);
    }, GRACE_MS);
  };
}

/** Keep the workspace stream open while the component is mounted. */
export function useWorkspaceStream(wid: string | null | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!wid) return;
    return acquireWorkspaceStream(wid, qc);
  }, [wid, qc]);
}

/** Subscribe to typed domain events (for panels that need the payload, e.g. a live run card). Also keeps the stream open. */
export function useWorkspaceEvents(wid: string | null | undefined, onEvent: (e: DomainEvent) => void) {
  useWorkspaceStream(wid);
  useEffect(() => {
    if (!wid) return;
    let set = eventListeners.get(wid);
    if (!set) eventListeners.set(wid, (set = new Set()));
    set.add(onEvent);
    return () => {
      set.delete(onEvent);
    };
  }, [wid, onEvent]);
}

export function useStreamStatus(wid: string | null | undefined): { status: StreamStatus; detail?: { reason?: string; retryInMs?: number } } {
  const status = useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    () => (wid ? (registry.get(wid)?.status ?? 'idle') : 'idle'),
    () => 'idle' as StreamStatus,
  );
  return { status, detail: wid ? registry.get(wid)?.detail : undefined };
}
