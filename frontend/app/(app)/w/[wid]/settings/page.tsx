import { Content, PageHeader } from '@/components/nx/shell';
import SettingsView from './settings-view';

export default async function Page({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  return (
    <>
      <PageHeader title="Workspace settings" description="Name, description, pinning, collaborators and invitations." />
      <Content>
        <SettingsView wid={wid} />
      </Content>
    </>
  );
}
