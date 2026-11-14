import { Content, PageHeader } from '@/components/nx/shell';
import { TimelineView } from '@/components/nx/investigate-lists';

export default async function Page({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  return (
    <>
      <PageHeader title="Timeline" description="Everything that changed in this workspace, newest first." />
      <Content>
        <TimelineView wid={wid} />
      </Content>
    </>
  );
}
