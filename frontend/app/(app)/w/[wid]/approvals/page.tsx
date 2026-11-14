import { Content, PageHeader } from '@/components/nx/shell';
import { ApprovalsView } from '@/components/nx/investigate-lists';

export default async function Page({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  return (
    <>
      <PageHeader title="Approvals" description="Actions that wait for a decision. Each decision is bound to the exact action hash." />
      <Content>
        <ApprovalsView wid={wid} />
      </Content>
    </>
  );
}
