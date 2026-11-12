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

export default function CapsulesView({ wid }: { wid: string }) {
  const q = useQuery({ queryKey: ['capsule-publications'], queryFn: caps.publications });
  return (
    <Card title="Capsules in this workspace">
      <Slot q={q}>
        {(d) => (
          <DataTable
            caption="Capsules"
            rows={d.publications.filter((p) => p.workspaceId === wid)}
            rowKey={(r) => r.capsuleId}
            empty={{ title: 'No capsules for this workspace', body: 'A capsule is built from a frozen snapshot and recorded against the workspace that owns it.' }}
            columns={[
              {
                key: 'title',
                header: 'Capsule',
                render: (r) => (
                  <Link className="link strong" href={`/w/${wid}/capsules/${encodeURIComponent(r.capsuleId)}`} data-testid="capsule-link">
                    {r.title}
                  </Link>
                ),
              },
              { key: 'label', header: 'Data label', render: (r) => <Badge tone={r.label === 'SYNTHETIC' ? 'warn' : 'info'} outline>{r.label}</Badge> },
              { key: 'state', header: 'Publication', render: (r) => <PublicationBadge state={r.state} /> },
              { key: 'badge', header: 'Badge', render: (r) => r.badge ?? <span className="dim">none</span> },
              { key: 'at', header: 'Created', render: (r) => <span className="mono small">{formatUtc(r.createdAt)}</span> },
            ]}
          />
        )}
      </Slot>
    </Card>
  );
}
