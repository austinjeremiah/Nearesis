import { NotConnected } from '@/components/nx/states';
import { Content, PageHeader } from '@/components/nx/shell';

/** Not connected to the API yet (WS4). Renders an honest typed state, never placeholder figures. */
export default function Page() {
  return (
    <>
      <PageHeader title="Experiment" description="Experiment detail." />
      <Content>
        <NotConnected what="Experiment" stream="WS4" />
      </Content>
    </>
  );
}
