import { Content, PageHeader } from '@/components/nx/shell';
import { DataNav } from '@/components/nx/data/kit';
import { SourcesList } from '@/components/nx/data/sources-view';

export default function Page() {
  return (
    <>
      <PageHeader title="Sources" description="Watermark, lag, gaps and 90-day coverage per data source." crumbs={[{ label: 'Data', href: '/data' }, { label: 'Sources' }]} />
      <Content>
        <DataNav />
        <SourcesList />
      </Content>
    </>
  );
}
