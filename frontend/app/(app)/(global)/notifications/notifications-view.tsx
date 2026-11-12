'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { DataTable, type Column } from '@/components/nx/table';
import { Badge } from '@/components/nx/evidence';
import { Segmented } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { Notice } from '@/components/nx/ui';
import { shellBrowser } from '@/lib/api/shell-browser';
import type { GlobalNotification } from '@/lib/api/shell';
import { formatAge, formatUtc } from '@/lib/format';

export default function NotificationsView() {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const q = useQuery({
    queryKey: ['global', 'notifications', filter],
    queryFn: () => shellBrowser.notifications({ unread: filter === 'unread' }),
  });
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
    { key: 'read', header: '', render: (n) => (n.readAt ? <span className="tiny dim">read</span> : <Badge tone="accent">unread</Badge>) },
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
      </div>
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
