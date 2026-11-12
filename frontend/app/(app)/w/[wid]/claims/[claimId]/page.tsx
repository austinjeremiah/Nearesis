import { NotConnected } from '@/components/nx/states';
import { Content, PageHeader } from '@/components/nx/shell';

/** Not connected to the API yet (WS4). Renders an honest typed state, never placeholder figures. */
export default function Page() {
  return (
    <>
      <PageHeader title="Claim" description="Claim detail." />
      <Content>
        <NotConnected what="Claim" stream="WS4" />
      </Content>
    </>
  );
}
