import { Content, PageHeader } from '@/components/nx/shell';
import { DataNav } from '@/components/nx/data/kit';
import RealtimeView from '@/components/nx/data/realtime-view';

export default function Page() {
  return (
    <>
      <PageHeader title="Real-time feed" description="Freshness of the near-real-time NEAR feed. Finalized and provisional figures are kept apart." crumbs={[{ label: 'Data', href: '/data' }, { label: 'Real-time feed' }]} />
      <Content>
        <DataNav />
        <RealtimeView />
      </Content>
    </>
  );
}
