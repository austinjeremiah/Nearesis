import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { api } from '@/lib/api/server';
import { settle } from '@/lib/api/guard';
import { workspaceLabel } from '@/lib/workspace/label';
import { ApiErrorState } from '@/components/nx/states';
import CostView from './cost-view';

/** Spend, caps, ledger, reconciliation and the global ceiling. Forecasts are projections; unknown prices stay unknown. */
export default async function CostPage({ params }: { params: Promise<{ wid: string }> }) {
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
        title="Cost"
        description="What this workspace has spent on paid work, what it is limited to, and what is projected. Unknown prices are shown as unknown, never as zero."
        crumbs={[{ label: 'Workspaces', href: '/workspaces' }, { label: workspaceLabel(r.data.objective, 40), href: `/w/${wid}/overview` }, { label: 'Cost' }]}
      />
      <Content>
        <CostView wid={wid} />
      </Content>
    </>
  );
}
