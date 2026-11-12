import { NotConnected } from '@/components/nx/states';
import { Content, PageHeader } from '@/components/nx/shell';

/** Not connected to the API yet (WS3). Renders an honest typed state, never placeholder figures. */
export default function Page() {
  return (
    <>
      <PageHeader title="Panel" description="Panel detail and provenance." />
      <Content>
        <NotConnected what="Panel" stream="WS3" />
      </Content>
    </>
  );
}
