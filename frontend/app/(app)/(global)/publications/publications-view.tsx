'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/nx/evidence';
import { DataTable } from '@/components/nx/table';
import { Card } from '@/components/nx/ui';
import { formatUtc } from '@/lib/format';
import { caps } from '@/lib/ws6/api';
import { Slot } from '@/components/ws6/common';
import { PublicationBadge } from '@/components/ws6/capsule-bits';

export default function PublicationsView() {
  const q = useQuery({ queryKey: ['capsule-publications'], queryFn: caps.publications });
  return (
    <Card title="All capsules">
      <Slot q={q}>
        {(d) => (
          <DataTable
            caption="Publications"
            rows={d.publications}
            rowKey={(r) => r.capsuleId}
            empty={{ title: 'No capsules yet', body: 'Capsules appear here once one is built for a workspace you can read.' }}
            columns={[
              {
                key: 'title',
                header: 'Capsule',
                render: (r) => (
                  <Link className="link strong" href={`/w/${r.workspaceId}/capsules/${encodeURIComponent(r.capsuleId)}`} data-testid="publication-link">
                    {r.title}
                  </Link>
                ),
              },
              { key: 'label', header: 'Data label', render: (r) => <Badge tone={r.label === 'SYNTHETIC' ? 'warn' : 'info'} outline>{r.label}</Badge> },
              { key: 'state', header: 'State', render: (r) => <PublicationBadge state={r.state} /> },
              { key: 'badge', header: 'Badge', render: (r) => r.badge ?? <span className="dim">none</span> },
              { key: 'ack', header: 'Acknowledged', render: (r) => (r.acknowledged.length ? <span className="mono small">{r.acknowledged.join(', ')}</span> : <span className="dim">nothing</span>) },
              { key: 'pub', header: 'Published', render: (r) => (r.publishedAt ? <span className="mono small">{formatUtc(r.publishedAt)}</span> : <span className="dim">not public</span>) },
              {
                key: 'public',
                header: 'Public page',
                render: (r) => (r.public ? <a className="link" href={`/public/${encodeURIComponent(r.capsuleId)}`}>open</a> : <span className="dim">none</span>),
              },
            ]}
          />
        )}
      </Slot>
    </Card>
  );
}
