import { NotConnected } from '@/components/nx/states';
import { Content, PageHeader } from '@/components/nx/shell';

/** Not connected to the API yet (WS4). Renders an honest typed state, never placeholder figures. */
export default function Page() {
  return (
    <>
      <PageHeader title="Experiments" description="Statistical results." />
      <Content>
        <NotConnected what="Experiments" stream="WS4" />
      </Content>
    </>
  );
}
