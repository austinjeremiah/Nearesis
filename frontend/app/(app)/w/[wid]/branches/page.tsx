import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { api } from '@/lib/api/server';
import { settle } from '@/lib/api/guard';
import { workspaceLabel } from '@/lib/workspace/label';
import { ApiErrorState } from '@/components/nx/states';
import PresenceBar from '@/components/ws6/presence';
import BranchesView from './branches-view';

/** Branches, diffs, merge proposals with conflicts and reviewer comments, merges into main. */
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
        title="Branches and merges"
        description="Explore an alternative on a branch, compare it with main, then propose a merge. A person accepts; conflicts are never overwritten silently."
        crumbs={[{ label: 'Workspaces', href: '/workspaces' }, { label: workspaceLabel(r.data.objective, 40), href: `/w/${wid}/overview` }, { label: 'Branches' }]}
        context={<PresenceBar wid={wid} scope="notes" />}
      />
      <Content>
        <BranchesView wid={wid} />
      </Content>
    </>
  );
}
