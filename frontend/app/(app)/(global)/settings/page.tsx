import { NotConnected } from '@/components/nx/states';
import { Content, PageHeader } from '@/components/nx/shell';

/** Not connected to the API yet (WS1). Renders an honest typed state, never placeholder figures. */
export default function Page() {
  return (
    <>
      <PageHeader title="Settings" description="Profile, organization, usage and integrations." />
      <Content>
        <NotConnected what="Settings" stream="WS1" />
      </Content>
    </>
  );
}
