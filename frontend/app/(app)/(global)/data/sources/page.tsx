'use client';

import { useRouter } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { DataTable, type Column } from '@/components/nx/table';
import { Badge, CoverageChip, DataModeIndicator, SourceHealthChip } from '@/components/nx/evidence';
import { LinkButton, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import type { Source } from '@/lib/data/fixtures';
import { formatAge, formatUtc } from '@/lib/format';

/**
 * Spec 5.10 — sources list.
 *
 * "No promises of real-time where provider lag exists." Each row shows the last
 * finalized watermark and its age rather than a live indicator, and a source
 * that has never sampled a route reads Not sampled rather than 0%.
 */
export default function SourcesPage() {
  const router = useRouter();
  const rows = db.sources();

  const columns: Column<Source>[] = [
    {
      key: 'name',
      header: 'Source',
      render: (s) => (
        <div className="col gap1">
          <span className="strong">{s.name}</span>
          <span className="tiny dim">{s.provider}</span>
        </div>
      ),
    },
    { key: 'health', header: 'Status', render: (s) => <SourceHealthChip health={s.health} /> },
    {
      key: 'watermark',
      header: 'Last finalized',
      render: (s) => (
        <span className="small mono" title={formatUtc(s.watermark)}>
          {formatAge(s.watermark)}
        </span>
      ),
    },
    {
      key: 'coverage',
      header: 'Coverage',
      render: (s) =>
        s.coveragePct !== null ? (
          <CoverageChip
            coverage={{
              expected: 180,
              observed: Math.round(180 * s.coveragePct),
              unknown: Math.round(180 * (1 - s.coveragePct)),
              gaps: [],
            }}
          />
        ) : (
          <Badge outline title="This source has not sampled a comparable window.">
            Not sampled
          </Badge>
        ),
    },
    { key: 'rate', header: 'Rate limit', render: (s) => <span className="small">{s.rateLimit}</span> },
    {
      key: 'checked',
      header: 'Checked',
      render: (s) => <span className="small mono">{formatAge(s.checkedAt)}</span>,
    },
    { key: 'mode', header: 'Mode', render: () => <Badge outline>Frozen · fixture</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Sources"
        description="Where every number in this instance came from, and what each provider cannot see."
        crumbs={[{ label: 'Explore data', href: '/data' }, { label: 'Sources' }]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
        actions={<LinkButton href="/data">Metric catalog</LinkButton>}
      />
      <Content>
        <Notice tone="warn" title="One source is degraded">
          Intents Explorer returned PARTNER_JWT_EXPIRED. The backfill is paused rather than
          retried, because a retry loop on a 401 costs money and cannot succeed. Panels that depend
          on it keep their last good data and say so.
        </Notice>

        <DataTable
          caption={`${rows.length} configured sources`}
          columns={columns}
          rows={rows}
          rowKey={(s) => s.id}
          onRowClick={(s) => router.push(`/data/sources/${s.id}`)}
        />

        <p className="tiny dim">
          A watermark is the latest finalized sample, not the current instant. A source with a six
          hour lag is healthy at six hours behind.
        </p>
      </Content>
    </>
  );
}
