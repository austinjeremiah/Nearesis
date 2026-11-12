import { Content, PageHeader } from '@/components/nx/shell';
import { DataNav } from '@/components/nx/data/kit';
import IntentsView from '@/components/nx/data/intents-view';

export default function Page() {
  return (
    <>
      <PageHeader title="NEAR Intents" description="Swap analytics from the provider Explorer (1Click transactions). Every figure carries its window, coverage and method." crumbs={[{ label: 'Data', href: '/data' }, { label: 'Intents' }]} />
      <Content>
        <DataNav />
        <IntentsView />
      </Content>
    </>
  );
}
