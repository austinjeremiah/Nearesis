'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge } from '@/components/nx/evidence';
import { Button } from '@/components/nx/ui';
import { DataTable, type Column } from '@/components/nx/table';
import { MarkerStatusBadge, ModeBadge, Slot } from '@/components/nx/research-kit';
import { MarkerCreateForm } from '@/components/nx/marker-create';
import { qk } from '@/lib/api/keys';
import { research, type Marker } from '@/lib/research/api';
import { formatAge, formatUtc } from '@/lib/format';

export function anchorText(m: Marker): string {
  const a = m.anchor;
  if (a.kind === 'time_range') return `${formatUtc(a.start ?? null, false)} to ${formatUtc(a.end ?? null, false)}`;
  if (a.kind === 'time_point') return formatUtc(a.at ?? null);
  if (a.kind === 'threshold') return `${a.metricId} ${a.op === 'gt' ? '>' : '<'} ${a.value}`;
  return `${a.sourceId} / ${a.eventId}`;
}

export default function MarkersView({ wid }: { wid: string }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: [...qk.markers(wid), 'list'], queryFn: () => research.markers(wid) });
  const cols: Column<Marker>[] = [
    { key: 'status', header: 'Status', render: (m) => <MarkerStatusBadge status={m.status} /> },
    { key: 'q', header: 'Question', width: '36%', render: (m) => <span className="small">{m.question ?? <span className="dim">No question</span>}</span> },
    { key: 'anchor', header: 'Anchor', render: (m) => <span className="small"><Badge outline>{m.anchorType.replace('_', ' ')}</Badge> {anchorText(m)}</span> },
    { key: 'agents', header: 'Agents', render: (m) => (m.assignedAgents.length ? m.assignedAgents.join(', ') : <span className="dim">none</span>) },
    { key: 'mode', header: 'Mode', render: (m) => <ModeBadge mode={m.mode} /> },
    { key: 'at', header: 'Created', render: (m) => <span className="small mono" title={formatUtc(m.timestamp)}>{formatAge(m.timestamp)}</span> },
  ];
  return (
    <>
      <PageHeader
        title="Markers"
        description="Questions anchored to a place on a panel. Assign an agent to investigate; attach the evidence it finds."
        actions={<Button variant="primary" onClick={() => setCreating((c) => !c)} data-testid="new-marker">{creating ? 'Close' : 'New marker'}</Button>}
      />
      <Content>
        <div className="col gap3">
          {creating && <MarkerCreateForm wid={wid} onCreated={(id) => router.push(`/w/${wid}/markers/${id}`)} />}
          <Slot q={q} rows={4}>
            {(d) => (
              <DataTable
                caption="Markers"
                columns={cols}
                rows={d.markers}
                rowKey={(m) => m.markerId}
                onRowClick={(m) => router.push(`/w/${wid}/markers/${m.markerId}`)}
                empty={{ title: 'No markers yet', body: 'Create one from a panel selection or with the form above.' }}
              />
            )}
          </Slot>
        </div>
      </Content>
    </>
  );
}
