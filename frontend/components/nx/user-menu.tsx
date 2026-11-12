'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { qk } from '@/lib/api/keys';
import type { Me } from '@/lib/api/types';
import { useStreamStatus } from '@/lib/sse/hub';
import { Button } from './ui';

/** Topbar identity, live-stream indicator and sign out. Everything here is real: /api/me and the SSE hub status. */
export function UserMenu({ workspaceId }: { workspaceId?: string | null }) {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: qk.me,
    queryFn: async (): Promise<Me> => {
      const r = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' });
      if (r.status === 401) {
        router.replace('/login');
        throw new Error('signed out');
      }
      if (!r.ok) throw new Error(`me ${r.status}`);
      return r.json();
    },
    retry: false,
    staleTime: 60_000,
  });
  const out = useMutation({
    mutationFn: async () => {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    },
    onSettled: () => {
      qc.clear();
      router.replace('/login');
    },
  });
  const stream = useStreamStatus(workspaceId);
  const label = me.data?.displayName ?? me.data?.email ?? (me.data?.subject ? `${me.data.subject.slice(0, 8)}` : null);
  return (
    <div className="row gap2">
      {workspaceId && (
        <span
          className="tiny mono dim"
          data-testid="stream-status"
          data-status={stream.status}
          title={stream.detail?.reason ? `Live updates: ${stream.status} (${stream.detail.reason})` : `Live updates: ${stream.status}`}
        >
          {stream.status === 'open' ? 'live' : stream.status === 'idle' ? '' : stream.status}
        </span>
      )}
      {label && (
        <span className="small dim mono" data-testid="me-label" title={me.data?.subject}>
          {label}
        </span>
      )}
      <Button variant="ghost" onClick={() => out.mutate()} pending={out.isPending} aria-label="Sign out">
        <LogOut size={14} />
        Sign out
      </Button>
    </div>
  );
}
