import { Content, PageHeader } from '@/components/nx/shell';
import NotificationsView from './notifications-view';

export default function Page() {
  return (
    <>
      <PageHeader title="Notifications" description="Monitor notifications across every workspace you can open, newest first." />
      <Content>
        <NotificationsView />
      </Content>
    </>
  );
}
