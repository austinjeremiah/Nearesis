import { NotConnected } from '@/components/nx/states';
import { Content, PageHeader } from '@/components/nx/shell';

/** Not connected to the API yet (WS1). Renders an honest typed state, never placeholder figures. */
export default function Page() {
  return (
    <>
      <PageHeader title="System health" description="Source and service health." />
      <Content>
        <NotConnected what="System health" stream="WS1" />
      </Content>
    </>
  );
}
