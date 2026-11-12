import { NotConnected } from '@/components/nx/states';
import { Content, PageHeader } from '@/components/nx/shell';

/** Not connected to the API yet (WS6). Renders an honest typed state, never placeholder figures. */
export default function Page() {
  return (
    <>
      <PageHeader title="Capsule" description="Capsule detail and verification." />
      <Content>
        <NotConnected what="Capsule" stream="WS6" />
      </Content>
    </>
  );
}
