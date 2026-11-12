import { Content, PageHeader } from '@/components/nx/shell';
import SettingsView from './settings-view';

export default function Page() {
  return (
    <>
      <PageHeader title="Settings" description="Your account, your organization, its members and invitations." />
      <Content>
        <SettingsView />
      </Content>
    </>
  );
}
