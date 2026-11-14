import { Content, PageHeader } from '@/components/nx/shell';
import AskForm, { RecentRuns } from '@/components/nx/ask-form';

/** Ask a question. The run itself opens on /runs/[runId]. */
export default async function Page({ params, searchParams }: { params: Promise<{ wid: string }>; searchParams: Promise<{ q?: string | string[] }> }) {
  const { wid } = await params;
  const q = (await searchParams).q;
  const initial = (Array.isArray(q) ? q[0] : q)?.slice(0, 4000) ?? '';
  return (
    <>
      <PageHeader title="Investigate" description="Ask a question. The plan, its budget and its approval step are shown before anything runs." />
      <Content>
        <AskForm wid={wid} initialQuestion={initial} />
        <RecentRuns wid={wid} />
      </Content>
    </>
  );
}
