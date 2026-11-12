import { Content, PageHeader } from '@/components/nx/shell';
import { DataNav } from '@/components/nx/data/kit';
import EconomicsView from '@/components/nx/data/economics-view';

export default function Page() {
  return (
    <>
      <PageHeader title="Economics" description="Gas and fees for the loaded window. Units are never mixed; USD appears only with a timestamped price." crumbs={[{ label: 'Data', href: '/data' }, { label: 'Economics' }]} />
      <Content>
        <DataNav />
        <EconomicsView />
      </Content>
    </>
  );
}
