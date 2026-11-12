import { Content, PageHeader } from '@/components/nx/shell';
import PublicationsView from './publications-view';

/** Every capsule of the organisation with its publication state (GET /v1/publications). */
export default function Page() {
  return (
    <>
      <PageHeader title="Publications" description="Capsules across your workspaces and whether each is public. Only published capsules are served publicly." />
      <Content>
        <PublicationsView />
      </Content>
    </>
  );
}
