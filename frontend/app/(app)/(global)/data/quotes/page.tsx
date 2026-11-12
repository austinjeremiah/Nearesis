import { Content, PageHeader } from '@/components/nx/shell';
import { DataNav } from '@/components/nx/data/kit';
import QuotesView from '@/components/nx/data/quotes-view';

export default function Page() {
  return (
    <>
      <PageHeader title="Quote observatory" description="Dry 1Click quote sampling per route: availability, latency, indicative cost and signature status." crumbs={[{ label: 'Data', href: '/data' }, { label: 'Quotes' }]} />
      <Content>
        <DataNav />
        <QuotesView />
      </Content>
    </>
  );
}
