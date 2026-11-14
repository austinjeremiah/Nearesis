import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { api } from '@/lib/api/server';
import { settle } from '@/lib/api/guard';
import { workspaceLabel } from '@/lib/workspace/label';
import { ApiErrorState } from '@/components/nx/states';
import CapsuleDetail from './capsule-detail';

/** One capsule. The route segment carries the capsule id (the API's identifier for it). */
export default async function CapsulePage({ params }: { params: Promise<{ wid: string; capsuleHash: string }> }) {
  const { wid, capsuleHash } = await params;
  const id = decodeURIComponent(capsuleHash);
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
        title="Capsule"
        description={id}
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: workspaceLabel(r.data.objective, 40), href: `/w/${wid}/overview` },
          { label: 'Capsules', href: `/w/${wid}/capsules` },
          { label: id },
        ]}
      />
      <Content>
        <CapsuleDetail wid={wid} capsuleId={id} />
      </Content>
    </>
  );
}
