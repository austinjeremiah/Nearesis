import { Content, PageHeader } from '@/components/nx/shell';
import { DataNav } from '@/components/nx/data/kit';
import { SourceDetail } from '@/components/nx/data/sources-view';

export default async function Page({ params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await params;
  const id = decodeURIComponent(sourceId);
  return (
    <>
      <PageHeader title={id} description="Source health: watermark, coverage heatmap, errors and rate limits." crumbs={[{ label: 'Data', href: '/data' }, { label: 'Sources', href: '/data/sources' }, { label: id }]} />
      <Content>
        <DataNav />
        <SourceDetail sourceId={id} />
      </Content>
    </>
  );
}
