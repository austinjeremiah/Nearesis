import { NotConnected } from '@/components/nx/states';
import { Content, PageHeader } from '@/components/nx/shell';

/** Not connected to the API yet (WS5). Renders an honest typed state, never placeholder figures. */
export default function Page() {
  return (
    <>
      <PageHeader title="Metric" description="Metric definition and versions." />
      <Content>
        <NotConnected what="Metric" stream="WS5" />
      </Content>
    </>
  );
}
