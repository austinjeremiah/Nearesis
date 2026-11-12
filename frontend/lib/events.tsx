'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ENV } from './env';

export const EVENT_TYPES = [
  'agent.linked', 'agent.revoked',
  'claim.posted', 'claim.won', 'claim.lost',
  'approval.pending', 'approval.resolved',
  'intent.created', 'payment.unknown', 'payment.paid', 'payment.void',
  'job.done', 'refund.sent', 'counter.update', 'chaos',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type FosEvent = { type: EventType; at: number; id?: string; data: Record<string, any> };
type Handler = (e: FosEvent) => void;

type Ctx = { status: 'connecting' | 'live' | 'down'; recent: FosEvent[]; on: (types: EventType[] | '*', h: Handler) => () => void };
const EventsCtx = createContext<Ctx | null>(null);

export function EventsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const handlers = useRef(new Set<{ types: EventType[] | '*'; h: Handler }>());
  const [status, setStatus] = useState<Ctx['status']>('connecting');
  const [recent, setRecent] = useState<FosEvent[]>([]);

  useEffect(() => {
    const es = new EventSource(`${ENV.API_URL}/v1/events`);
    const listener = (type: EventType) => (m: MessageEvent) => {
      let data: Record<string, any> = {};
      try { data = JSON.parse(m.data); } catch { return; }
      const ev: FosEvent = { type, at: Date.now(), id: m.lastEventId || undefined, data };
      setRecent((r) => [ev, ...r].slice(0, 80));
      handlers.current.forEach(({ types, h }) => { if (types === '*' || types.includes(type)) h(ev); });
    };
    const ls = EVENT_TYPES.map((t) => [t, listener(t)] as const);
    ls.forEach(([t, f]) => es.addEventListener(t, f as EventListener));
    es.onopen = () => { setStatus('live'); qc.invalidateQueries(); };
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? 'down' : 'connecting');
    return () => { ls.forEach(([t, f]) => es.removeEventListener(t, f as EventListener)); es.close(); };
  }, [qc]);

  const on: Ctx['on'] = (types, h) => {
    const entry = { types, h };
    handlers.current.add(entry);
    return () => { handlers.current.delete(entry); };
  };
  return <EventsCtx.Provider value={{ status, recent, on }}>{children}</EventsCtx.Provider>;
}

export function useEvents() {
  const c = useContext(EventsCtx);
  if (!c) throw new Error('useEvents outside EventsProvider');
  return c;
}

/** Subscribe for the component's lifetime. The handler may change every render. */
export function useEvent(types: EventType[] | '*', handler: Handler) {
  const { on } = useEvents();
  const ref = useRef(handler);
  ref.current = handler;
  const key = types === '*' ? '*' : types.join(',');
  useEffect(() => on(types, (e) => ref.current(e)), [key]); // eslint-disable-line react-hooks/exhaustive-deps
}
