'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { DataTable, type Column } from '@/components/nx/table';
import { Badge, DataModeIndicator } from '@/components/nx/evidence';
import { Button, Input, LinkButton, Notice, Segmented } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import type { Metric } from '@/lib/data/fixtures';

/**
 * Spec 5.9 — metric catalog.
 *
 * "Discover governable data, not direct arbitrary SQL access." There is no
 * query box on this page. A measure is explored through its definition and a
 * bounded preview, and an uncertified draft is marked as such rather than
 * sitting alongside certified measures unlabelled.
 */
type Filter = 'all' | 'certified' | 'draft';

export default function MetricCatalogPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    let out = db.metrics();
    if (filter === 'certified') out = out.filter((m) => m.certified);
    if (filter === 'draft') out = out.filter((m) => !m.certified);
    const needle = q.trim().toLowerCase();
    if (needle) {
      out = out.filter(
        (m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle),
      );
    }
    return out;
  }, [filter, q]);

  const columns: Column<Metric>[] = [
    {
      key: 'name',
      header: 'Measure',
      render: (m) => (
        <div className="col gap1">
          <span className="strong">{m.name}</span>
          <span className="tiny mono dim">{m.id}</span>
        </div>
      ),
    },
    { key: 'unit', header: 'Unit', render: (m) => <span className="small mono">{m.unit}</span> },
    { key: 'kind', header: 'Kind', render: (m) => <span className="small">{m.kind}</span> },
    { key: 'grain', header: 'Grain', render: (m) => <span className="small mono">{m.grain}</span> },
    {
      key: 'source',
      header: 'Source',
      render: (m) => <span className="small">{db.source(m.sourceId)?.name ?? m.sourceId}</span>,
    },
    { key: 'version', header: 'Definition', render: (m) => <span className="small mono">{m.version}</span> },
    {
      key: 'lag',
      header: 'Lag',
      numeric: true,
      render: (m) => <span className="small mono">{m.lagHours}h</span>,
    },
    {
      key: 'certified',
      header: 'Certification',
      render: (m) =>
        m.certified ? <Badge tone="ok">Certified</Badge> : <Badge tone="warn">Workspace draft</Badge>,
    },
    {
      key: 'visibility',
      header: 'Visibility',
      render: (m) => (
        <Badge
          outline
          title={
            m.visibility === 'partial'
              ? 'Some activity under this measure is not publicly observable.'
              : undefined
          }
        >
          {m.visibility}
        </Badge>
      ),
    },
    {
      key: 'caveat',
      header: 'Caveat',
      render: (m) =>
        m.proxyCaveat ? (
          <Badge tone="info" title={m.proxyCaveat}>
            Proxy
          </Badge>
        ) : (
          <span className="unavailable" />
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Explore data"
        description="Certified measures govern what any agent can ask. Nothing here opens a SQL console."
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
        actions={
          <>
            <LinkButton href="/data/sources">Sources</LinkButton>
            <LinkButton href="/data/quotes">Quote observatory</LinkButton>
          </>
        }
      />
      <Content>
        <Notice tone="info" title="Why there is no query box here">
          Agents compose certified measures through the semantic gateway. Unrestricted SQL never
          reaches the warehouse, from a person or a model, which is what makes a query hash mean
          the same thing to two different readers.
        </Notice>

        <div className="row gap3 wrap">
          <Segmented<Filter>
            ariaLabel="Filter measures"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'certified', label: 'Certified' },
              { value: 'draft', label: 'Workspace drafts' },
            ]}
          />
          <div style={{ maxWidth: 320, flex: 1 }}>
            <Input
              placeholder="Search measure id or name"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search measures"
            />
          </div>
          <div className="grow" />
          <Button disabled disabledReason="Requesting a definition change needs the authorized API.">
            Request metric change
          </Button>
        </div>

        <DataTable
          caption={`${rows.length} measures in the catalog`}
          columns={columns}
          rows={rows}
          rowKey={(m) => m.id}
          onRowClick={(m) => router.push(`/data/metrics/${m.id}`)}
          state={{ status: q && rows.length === 0 ? 'no_results' : 'ready' }}
        />
      </Content>
    </>
  );
}
