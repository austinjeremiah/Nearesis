import { NotConnected } from '@/components/nx/states';
import { Content, PageHeader } from '@/components/nx/shell';

/** Not connected to the API yet (WS2). Renders an honest typed state, never placeholder figures. */
export default function Page() {
  return (
    <>
      <PageHeader title="Investigate" description="Ask and plan." />
      <Content>
        <NotConnected what="Investigate" stream="WS2" />
      </Content>
    </>
  );
}
