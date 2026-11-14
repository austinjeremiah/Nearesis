import { Content, PageHeader } from '@/components/nx/shell';
import { DataNav } from '@/components/nx/data/kit';
import AccountsView from '@/components/nx/data/accounts-view';

export default function Page() {
  return (
    <>
      <PageHeader title="Accounts" description="Daily active accounts, new versus returning, retention, concentration and high-frequency labels. Accounts are not people." crumbs={[{ label: 'Data', href: '/data' }, { label: 'Accounts' }]} />
      <Content>
        <DataNav />
        <AccountsView />
      </Content>
    </>
  );
}
