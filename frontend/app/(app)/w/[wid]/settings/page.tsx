import { NotConnected } from '@/components/nx/states';
import { Content, PageHeader } from '@/components/nx/shell';

/** Not connected to the API yet (WS1). Renders an honest typed state, never placeholder figures. */
export default function Page() {
  return (
    <>
      <PageHeader title="Workspace settings" description="Objective, budget and members." />
      <Content>
        <NotConnected what="Workspace settings" stream="WS1" />
      </Content>
    </>
  );
}
