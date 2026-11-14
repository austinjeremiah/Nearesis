import { Content, PageHeader } from '@/components/nx/shell';
import RunView from '@/components/nx/run-view';

export default async function Page({ params }: { params: Promise<{ wid: string; runId: string }> }) {
  const { wid, runId } = await params;
  return (
    <>
      <PageHeader
        title="Investigation run"
        description={`Run ${runId}`}
        crumbs={[{ label: 'Investigate', href: `/w/${wid}/investigate` }, { label: 'Run' }]}
      />
      <Content>
        <RunView wid={wid} runId={runId} />
      </Content>
    </>
  );
}
