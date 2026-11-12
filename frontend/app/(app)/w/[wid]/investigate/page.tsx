import { Content, PageHeader } from '@/components/nx/shell';
import AskForm, { RecentRuns } from '@/components/nx/ask-form';

/** Ask a question. The run itself opens on /runs/[runId]. */
export default async function Page({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  return (
    <>
      <PageHeader title="Investigate" description="Ask a question. The plan, its budget and its approval step are shown before anything runs." />
      <Content>
        <AskForm wid={wid} />
        <RecentRuns wid={wid} />
      </Content>
    </>
  );
}
