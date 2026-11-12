import { Content, PageHeader } from '@/components/nx/shell';
import NewWorkspaceForm from './new-workspace-form';

export default function NewWorkspacePage() {
  return (
    <>
      <PageHeader
        title="New workspace"
        description="A workspace holds one research question. Create it, then ask the question from its Investigate page."
        crumbs={[{ label: 'Workspaces', href: '/workspaces' }, { label: 'New' }]}
      />
      <Content>
        <NewWorkspaceForm />
      </Content>
    </>
  );
}
