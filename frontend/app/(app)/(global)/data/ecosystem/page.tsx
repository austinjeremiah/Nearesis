import { Content, PageHeader } from '@/components/nx/shell';
import { DataNav } from '@/components/nx/data/kit';
import EcosystemView from '@/components/nx/data/ecosystem-view';

export default function Page() {
  return (
    <>
      <PageHeader title="Ecosystem" description="Entity registry with evidence, classification coverage and 90-day changes. Labels say verified or inferred; unattributed growth is shown, not hidden." crumbs={[{ label: 'Data', href: '/data' }, { label: 'Ecosystem' }]} />
      <Content>
        <DataNav />
        <EcosystemView />
      </Content>
    </>
  );
}
