'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MoreHorizontal } from 'lucide-react';
import { Content, PageHeader } from '@/components/nx/shell';
import { DataTable, type Column } from '@/components/nx/table';
import { Menu } from '@/components/nx/overlays';
import { IconButton, Input, LinkButton, Segmented } from '@/components/nx/ui';
import { Badge, DataModeIndicator } from '@/components/nx/evidence';
import * as db from '@/lib/data/client';
import type { Workspace } from '@/lib/data/fixtures';
import { formatAge, formatUsd } from '@/lib/format';

/**
 * Spec 5.3 — workspace portfolio.
 *
 * A table by default, because density matters more than card decoration when
 * the question is "which of my investigations needs me". The row menu only
 * offers actions that exist; the rest state why they do not.
 */
type Scope = 'all' | 'mine' | 'shared' | 'archived';

export default function WorkspacesPage() {
  const router = useRouter();
  const [scope, setScope] = useState<Scope>('all');
  const [q, setQ] = useState('');

  const all = db.workspaces();
  const rows = useMemo(() => {
    let out = all;
    if (scope === 'mine') out = out.filter((w) => w.owner === 'you' && !w.archived);
    else if (scope === 'shared') out = out.filter((w) => w.owner !== 'you' && !w.archived);
    else if (scope === 'archived') out = out.filter((w) => w.archived);
    else out = out.filter((w) => !w.archived);
    const needle = q.trim().toLowerCase();
    if (needle) {
      out = out.filter(
        (w) =>
          w.name.toLowerCase().includes(needle) || w.objective.toLowerCase().includes(needle),
      );
    }
    return out;
  }, [all, scope, q]);

  const columns: Column<Workspace>[] = [
    {
      key: 'name',
      header: 'Workspace',
      // The widest column in the table, named so the name and its pinned mark
      // are not the first thing the browser squeezes when the rail is open.
      // A hard minimum on the cell, because `width` alone is only a hint to the
      // auto table layout and the nowrap columns were taking this column's room.
      width: '22%',
      render: (w) => (
        // A hard minimum, because `width` alone is only a hint to the auto table
        // layout and the nowrap columns were taking the name column's room.
        <div className="col gap1" style={{ minWidth: 200 }}>
          <span className="strong row gap2 wrap">
            {w.name}
            {w.pinned && <Badge outline>Pinned</Badge>}
          </span>
          <span className="tiny dim clamp-2" title={w.objective}>
            {w.objective}
          </span>
        </div>
      ),
    },
    { key: 'template', header: 'Template', render: (w) => <span className="small">{w.template}</span> },
    {
      key: 'activity',
      header: 'Last activity',
      render: (w) => <span className="small mono">{formatAge(w.updatedAt)}</span>,
    },
    {
      key: 'vintage',
      header: 'Data vintage',
      render: (w) => <span className="small mono">{w.snapshotId}</span>,
    },
    {
      key: 'run',
      header: 'Current run',
      render: (w) => {
        const r = db.activeRun(w.id);
        return r ? <Badge tone="info">Running</Badge> : <span className="unavailable" />;
      },
    },
    { key: 'owner', header: 'Owner', render: (w) => <Badge outline>{w.owner}</Badge> },
    {
      key: 'collab',
      header: 'Collaborators',
      numeric: true,
      render: (w) => <span className="small mono">{w.collaborators}</span>,
    },
    {
      key: 'spend',
      header: 'Spend',
      numeric: true,
      render: (w) => (
        <span className="small mono">
          {formatUsd(w.spentUsd)} / {formatUsd(w.budgetUsd)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Publication',
      render: (w) => (
        <Badge tone={w.thesisStatus === 'published' ? 'ok' : w.thesisStatus === 'review_required' ? 'warn' : ''}>
          {w.thesisStatus.replace(/_/g, ' ')}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (w) => (
        <Menu
          trigger={
            <IconButton label={`Actions for ${w.name}`} onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal size={15} />
            </IconButton>
          }
          items={[
            { label: 'Open', href: `/w/${w.id}/overview` },
            { label: 'View activity', href: `/w/${w.id}/timeline` },
            { kind: 'separator' },
            { label: 'Rename', disabledReason: 'Needs the authorized API. Read-only on fixture data.' },
            { label: 'Pin', disabledReason: 'Needs the authorized API. Read-only on fixture data.' },
            { label: 'Fork from snapshot', disabledReason: 'Needs the authorized API. Read-only on fixture data.' },
            { kind: 'separator' },
            {
              label: w.archived ? 'Restore' : 'Archive',
              danger: !w.archived,
              disabledReason: 'Needs the authorized API. Read-only on fixture data.',
            },
          ]}
        />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="One workspace holds exactly one research question, with its own budget, agents and evidence."
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
        actions={
          <LinkButton href="/workspaces/new" variant="primary">
            New workspace
          </LinkButton>
        }
      />
      <Content>
        <div className="row gap3 wrap">
          <Segmented<Scope>
            ariaLabel="Filter workspaces"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'All' },
              { value: 'mine', label: 'Mine' },
              { value: 'shared', label: 'Shared' },
              { value: 'archived', label: 'Archived' },
            ]}
          />
          <div style={{ maxWidth: 320, flex: 1 }}>
            <Input
              placeholder="Search name or objective"
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
          state={{ status: q && rows.length === 0 ? 'no_results' : rows.length === 0 ? 'empty' : 'ready' }}
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
      </Content>
    </>
  );
}
