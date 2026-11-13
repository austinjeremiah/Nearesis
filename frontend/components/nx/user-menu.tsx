'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, LogOut, ShieldCheck } from 'lucide-react';
import { qk } from '@/lib/api/keys';
import { shellBrowser } from '@/lib/api/shell-browser';
import { ApiRequestError } from '@/lib/api/errors';
import { useStreamStatus } from '@/lib/sse/hub';
import { formatUsd } from '@/lib/format';
import { Button } from './ui';
import { ThemeToggle } from './theme';

/**
 * Topbar: live-stream indicator, spend status (global USD ceiling, and this
 * workspace's budget when one is open), pending approvals, unread notifications,
 * identity and sign out. Every figure comes from the API; a refused or missing
 * figure renders nothing rather than a placeholder.
 */

const POLL = 30_000;

function GlobalSpendChip() {
  const q = useQuery({
    queryKey: ['global', 'cost'],
    queryFn: () => shellBrowser.costGlobal(),
    refetchInterval: POLL,
    retry: false,
  });
  // The ceiling is owner/admin data: other roles get 403 and see no chip.
  if (!q.data) return null;
  const s = q.data;
  const tone = s.state === 'ok' ? '' : s.state === 'warning' ? ' warn' : ' bad';
  return (
    <Link
      href="/system#spend"
      className={`badge line${tone}`}
      data-testid="global-spend"
      data-state={s.state}
      title={`Global model-spend ceiling ${formatUsd(s.ceilingUsd)}; committed ${formatUsd(s.committedUsd)}; remaining ${formatUsd(s.remainingUsd)}${s.unknownPriceEntries ? `; ${s.unknownPriceEntries} entries with unknown price are not counted` : ''}`}
    >
      Model spend {formatUsd(s.committedUsd)} / {formatUsd(s.ceilingUsd)}
    </Link>
  );
}

function WorkspaceBudgetChip({ workspaceId }: { workspaceId: string }) {
  const q = useQuery({
    queryKey: [...qk.scope(workspaceId), 'burn'],
    queryFn: () => shellBrowser.workspaceBurn(workspaceId),
    refetchInterval: POLL,
    retry: false,
  });
  if (!q.data) return null;
  const b = q.data;
  const label = b.hardStopped
    ? 'Budget stopped'
    : b.capUsd === null
      ? `Workspace spend ${formatUsd(b.spentUsd)} (no cap set)`
      : `Workspace ${formatUsd(b.spentUsd)} / ${formatUsd(b.capUsd)}`;
  return (
    <span
      className={`badge line${b.hardStopped ? ' bad' : ''}`}
      data-testid="workspace-budget"
      data-hard-stopped={b.hardStopped ? 'true' : 'false'}
      title={b.hardStopReason ?? undefined}
    >
      {label}
    </span>
  );
}

export function UserMenu({ workspaceId }: { workspaceId?: string | null }) {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        return await shellBrowser.me();
      } catch (e) {
        if (e instanceof ApiRequestError && e.kind === 'unauthenticated') router.replace('/login');
        throw e;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
  const pending = useQuery({
    queryKey: ['global', 'approvals', 'pending'],
    queryFn: () => shellBrowser.approvals('pending'),
    refetchInterval: POLL,
    retry: false,
  });
  const notes = useQuery({
    queryKey: ['global', 'notifications', 'unread'],
    queryFn: () => shellBrowser.notifications({ unread: true, limit: 1 }),
    refetchInterval: POLL,
    retry: false,
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
  const m = me.data;
  const label = m?.principal.displayName ?? (m ? m.principal.userId.slice(0, 8) : null);
  const nPending = pending.data?.approvals.length ?? 0;
  const nUnread = notes.data?.unread ?? 0;
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
      {workspaceId && <WorkspaceBudgetChip workspaceId={workspaceId} />}
      <GlobalSpendChip />
      <ThemeToggle />
      {pending.data && (
        <Link
          href="/home#attention"
          className={`btn ghost${nPending ? ' has-count' : ''}`}
          aria-label={`${nPending} approvals waiting`}
          data-testid="pending-approvals"
          data-count={nPending}
        >
          <ShieldCheck size={14} />
          {nPending > 0 && <span className="badge warn">{nPending}</span>}
        </Link>
      )}
      {notes.data && (
        <Link
          href="/notifications"
          className="btn ghost"
          aria-label={`${nUnread} unread notifications`}
          data-testid="unread-notifications"
          data-count={nUnread}
        >
          <Bell size={14} />
          {nUnread > 0 && <span className="badge accent">{nUnread}</span>}
        </Link>
      )}
      {label && (
        <Link href="/settings" className="small dim mono" data-testid="me-label" title={`${m?.principal.userId} · ${m?.org.name} · ${m?.role}`}>
          {label}
          {m && <span className="tiny"> · {m.role}</span>}
        </Link>
      )}
      <Button variant="ghost" onClick={() => out.mutate()} pending={out.isPending} aria-label="Sign out">
        <LogOut size={14} />
        Sign out
      </Button>
    </div>
  );
}
