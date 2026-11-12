import { Content, PageHeader } from '@/components/nx/shell';
import { AgentsView } from '@/components/nx/investigate-lists';

export default async function Page({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  return (
    <>
      <PageHeader title="Agents and runs" description="Investigation runs in this workspace and the agents that did the work." />
      <Content>
        <AgentsView wid={wid} />
      </Content>
    </>
  );
}
