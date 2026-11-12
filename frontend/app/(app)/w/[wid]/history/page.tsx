import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { api } from '@/lib/api/server';
import { settle } from '@/lib/api/guard';
import { workspaceLabel } from '@/lib/workspace/label';
import { ApiErrorState } from '@/components/nx/states';
import PresenceBar from '@/components/ws6/presence';
import HistoryView from './history-view';

/** Time machine: revision timeline, snapshots with their data vintage, compare. Historical data only; never today's data. */
export default async function HistoryPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const r = await settle(api.workspace(wid));
  if (!r.ok) {
    if (r.error.kind === 'not_found') notFound();
    return (
      <Content>
        <ApiErrorState error={r.error} />
      </Content>
    );
  }
  return (
    <>
      <PageHeader
        title="Time machine"
        description="Open any recorded revision or snapshot. Every view is labelled historical and carries its data vintage."
        crumbs={[{ label: 'Workspaces', href: '/workspaces' }, { label: workspaceLabel(r.data.objective, 40), href: `/w/${wid}/overview` }, { label: 'Time machine' }]}
        context={<PresenceBar wid={wid} scope="notes" />}
      />
      <Content>
        <HistoryView wid={wid} />
      </Content>
    </>
  );
}
