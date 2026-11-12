'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import { DataTable, type Column } from '@/components/nx/table';
import { Menu } from '@/components/nx/overlays';
import { IconButton, Input } from '@/components/nx/ui';
import { Badge } from '@/components/nx/evidence';
import { ApiErrorState } from '@/components/nx/states';
import { browserApi } from '@/lib/api/browser';
import { qk } from '@/lib/api/keys';
import type { Ok } from '@/lib/api/types';
import { formatAge, formatUtc } from '@/lib/format';

type Row = Ok<'getWorkspaces'>['workspaces'][number];

/** Portfolio table over GET /v1/workspaces. Only columns the API returns; nothing is filled in. */
export default function WorkspacesView() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const query = useQuery({ queryKey: qk.workspaces, queryFn: () => browserApi.workspaces() });

  const rows = useMemo(() => {
    const all = query.data?.workspaces ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((w) => w.objective.toLowerCase().includes(needle) || w.id.includes(needle)) : all;
  }, [query.data, q]);

  const columns: Column<Row>[] = [
    {
      key: 'objective',
      header: 'Workspace',
      width: '40%',
      render: (w) => (
        <div className="col gap1" style={{ minWidth: 0 }}>
          <span className="strong">{w.objective}</span>
          <span className="tiny dim mono">{w.id}</span>
        </div>
      ),
    },
    { key: 'scope', header: 'Network scope', render: (w) => <Badge outline>{w.networkScope}</Badge> },
    {
      key: 'created',
      header: 'Created',
      render: (w) => (
        <span className="small mono" title={formatUtc(w.createdAt)}>
          {formatAge(w.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (w) => (
        <Menu
          trigger={
            <IconButton label={`Actions for ${w.objective}`} onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal size={15} />
            </IconButton>
          }
          items={[
            { label: 'Open', href: `/w/${w.id}/overview` },
            { label: 'View activity', href: `/w/${w.id}/timeline` },
          ]}
        />
      ),
    },
  ];

  if (query.isError) return <ApiErrorState error={query.error} onRetry={() => query.refetch()} />;

  return (
    <>
      <div className="row gap3 wrap">
        <div style={{ maxWidth: 320, flex: 1 }}>
          <Input
            placeholder="Search objective"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search workspaces"
          />
        </div>
      </div>
      <DataTable
        caption={`${rows.length} workspaces`}
        columns={columns}
        rows={rows}
        rowKey={(w) => w.id}
        state={{
          status: query.isPending ? 'loading' : q && rows.length === 0 ? 'no_results' : rows.length === 0 ? 'empty' : 'ready',
        }}
        onRowClick={(w) => router.push(`/w/${w.id}/overview`)}
        empty={{
          title: 'Every thesis starts with a question',
          body: 'No research workspaces here yet.',
          action: (
            <Link className="btn primary" href="/workspaces/new">
              Create workspace
            </Link>
          ),
        }}
      />
    </>
  );
}
