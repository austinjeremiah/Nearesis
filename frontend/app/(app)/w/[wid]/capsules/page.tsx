import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { api } from '@/lib/api/server';
import { settle } from '@/lib/api/guard';
import { workspaceLabel } from '@/lib/workspace/label';
import { ApiErrorState } from '@/components/nx/states';
import CapsulesView from './capsules-view';

/** Capsules of this workspace with their verification and publication state. */
export default async function CapsulesPage({ params }: { params: Promise<{ wid: string }> }) {
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
        title="Capsules"
        description="Reproducible research capsules. Reproduced means recomputed locally; attested means an OutLayer proof passed the proof policy. They are different claims."
        crumbs={[{ label: 'Workspaces', href: '/workspaces' }, { label: workspaceLabel(r.data.objective, 40), href: `/w/${wid}/overview` }, { label: 'Capsules' }]}
      />
      <Content>
        <CapsulesView wid={wid} />
      </Content>
    </>
  );
}
