import { Content, PageHeader } from '@/components/nx/shell';
import ThesisList from '@/components/nx/thesis/thesis-list';

export const metadata = { title: 'Theses' };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Theses"
        description="Every thesis you can open: the NEAR Intents reference, the ones built from your workspaces, and the ones shared with you. Verify one, share it, or reproduce it in your own account."
        crumbs={[{ label: 'Home', href: '/home' }, { label: 'Theses' }]}
      />
      <Content>
        <ThesisList />
      </Content>
    </>
  );
}
