'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/nx/evidence';
import { collab } from '@/lib/ws6/api';
import { qk } from '@/lib/api/keys';

type Peer = { userId: string; state: Record<string, unknown> };
type Status = 'connecting' | 'open' | 'closed' | 'denied';

/**
 * Who else is in this workspace. The collaborator list is HTTP; live presence comes over the Yjs
 * collaboration WebSocket, opened with a single-use ticket from the BFF (the bearer never reaches script).
 * A closed socket reconnects with a fresh ticket and says so; it never shows invented peers.
 */
export default function PresenceBar({ wid, scope = 'notes' }: { wid: string; scope?: 'layout' | 'notes' }) {
  const people = useQuery({ queryKey: [...qk.scope(wid), 'collaborators'], queryFn: () => collab.collaborators(wid) });
  const [peers, setPeers] = useState<Peer[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const stop = useRef(false);

  useEffect(() => {
    stop.current = false;
    let sock: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const open = async () => {
      if (stop.current) return;
      setStatus('connecting');
      try {
        const r = await fetch(`/api/collab/${encodeURIComponent(wid)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope }),
          credentials: 'same-origin',
        });
        if (!r.ok) {
          setStatus(r.status === 401 || r.status === 403 || r.status === 404 ? 'denied' : 'closed');
          if (r.status < 400 || r.status >= 500) schedule();
          return;
        }
        const t = (await r.json()) as { wsUrl: string; subprotocol: string };
        sock = new WebSocket(`${t.wsUrl}`, [t.subprotocol]);
        sock.onopen = () => {
          attempt = 0;
          setStatus('open');
          sock?.send(JSON.stringify({ type: 'presence', state: { page: location.pathname } }));
        };
        sock.onmessage = (ev) => {
          try {
            const f = JSON.parse(String(ev.data)) as { type: string; peers?: Peer[] };
            if (f.type === 'presence' && f.peers) setPeers(f.peers);
          } catch {
            /* ignore malformed frames */
          }
        };
        sock.onclose = () => {
          setStatus('closed');
          setPeers([]);
          schedule();
        };
        sock.onerror = () => sock?.close();
      } catch {
        setStatus('closed');
        schedule();
      }
    };
    const schedule = () => {
      if (stop.current) return;
      attempt += 1;
      timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** attempt));
    };
    void open();
    return () => {
      stop.current = true;
      if (timer) clearTimeout(timer);
      sock?.close();
    };
  }, [wid, scope]);

  const names = new Map((people.data?.collaborators ?? []).map((c) => [c.userId, c]));
  return (
    <div className="row gap2" data-testid="presence" data-status={status} data-peers={peers.length}>
      <Badge tone={status === 'open' ? 'ok' : status === 'denied' ? 'bad' : 'warn'} outline>
        {status === 'open' ? 'live' : status === 'connecting' ? 'connecting' : status === 'denied' ? 'no access' : 'reconnecting'}
      </Badge>
      {peers.length === 0 ? (
        <span className="small dim">{status === 'open' ? 'Only you here' : ''}</span>
      ) : (
        peers.map((p) => (
          <Badge key={p.userId} tone="info" title={String(p.state?.page ?? '')}>
            {names.get(p.userId)?.displayName ?? p.userId.slice(0, 8)}
          </Badge>
        ))
      )}
      <span className="tiny dim" data-testid="collaborator-count">
        {people.data ? `${people.data.collaborators.length} members` : ''}
      </span>
    </div>
  );
}
