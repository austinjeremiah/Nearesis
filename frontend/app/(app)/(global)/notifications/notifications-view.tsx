'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable, type Column } from '@/components/nx/table';
import { Badge } from '@/components/nx/evidence';
import { Button, Segmented } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { Notice } from '@/components/nx/ui';
import { shellBrowser } from '@/lib/api/shell-browser';
import type { GlobalNotification } from '@/lib/api/shell';
import { formatAge, formatUtc } from '@/lib/format';

export default function NotificationsView() {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const qc = useQueryClient();
  const mark = useMutation({
    mutationFn: (which: { ids: string[] } | { all: true }) => shellBrowser.markNotificationsRead(which),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['global'] }),
  });
  const q = useQuery({
    queryKey: ['global', 'notifications', filter],
    queryFn: () => shellBrowser.notifications({ unread: filter === 'unread' }),
  });
  const markErr = mark.error ? <ApiErrorState error={mark.error} /> : null;
  if (q.isError) return <ApiErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rows = q.data?.notifications ?? [];
  const columns: Column<GlobalNotification>[] = [
    {
      key: 'title',
      header: 'Notification',
      width: '46%',
      render: (n) => (
        <div className="col gap1">
          <span className={n.readAt ? '' : 'strong'}>{n.title}</span>
          <span className="small dim">{n.body}</span>
        </div>
      ),
    },
    { key: 'mode', header: 'Mode', render: (n) => <Badge outline>{n.mode}</Badge> },
    {
      key: 'ws',
      header: 'Workspace',
      render: (n) => (
        <Link className="link" href={`/w/${n.workspaceId}/monitors`}>
          {n.workspaceObjective}
        </Link>
      ),
    },
    {
      key: 'at',
      header: 'When',
      render: (n) => (
        <span className="small mono" title={formatUtc(n.createdAt)}>
          {formatAge(n.createdAt)}
        </span>
      ),
    },
    {
      key: 'read',
      header: '',
      render: (n) =>
        n.readAt ? (
          <span className="tiny dim" data-testid="notification-read">read</span>
        ) : (
          <span className="row gap2">
            <Badge tone="accent">unread</Badge>
            <Button variant="ghost" data-testid="mark-read" aria-label={`Mark read: ${n.title}`} pending={mark.isPending && mark.variables && 'ids' in mark.variables && mark.variables.ids.includes(n.notificationId)} onClick={() => mark.mutate({ ids: [n.notificationId] })}>
              Mark read
            </Button>
          </span>
        ),
    },
  ];
  return (
    <div className="col gap3">
      <div className="row gap3">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'unread', label: `Unread${q.data ? ` (${q.data.unread})` : ''}` },
          ]}
          ariaLabel="Filter notifications"
        />
        <Button
          data-testid="mark-all-read"
          disabled={!q.data || q.data.unread === 0}
          disabledReason="Nothing is unread."
          pending={mark.isPending && !!mark.variables && 'all' in mark.variables}
          onClick={() => mark.mutate({ all: true })}
        >
          Mark all read
        </Button>
      </div>
      {markErr}
      {q.data?.truncated && (
        <Notice tone="warn" title="List truncated">
          More notifications exist than this page loads. Open a workspace's monitors to see the rest.
        </Notice>
      )}
      <div data-testid="notifications">
        <DataTable
          caption={`${rows.length} notifications`}
          columns={columns}
          rows={rows}
          rowKey={(n) => n.notificationId}
          state={{ status: q.isPending ? 'loading' : rows.length === 0 ? 'empty' : 'ready' }}
          empty={{
            title: filter === 'unread' ? 'No unread notifications' : 'No notifications yet',
            body: 'Monitors raise a notification when a rule fires. None have fired in the workspaces you can open.',
          }}
        />
      </div>
    </div>
  );
}
