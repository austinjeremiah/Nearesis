import { Content, PageHeader } from '@/components/nx/shell';
import { LinkButton } from '@/components/nx/ui';
import WorkspacesView from './workspaces-view';

/**
 * Spec 5.3 — workspace portfolio, backed by GET /v1/workspaces. A table by
 * default, because density matters more than card decoration when the
 * question is "which of my investigations needs me".
 */
export default function WorkspacesPage() {
  return (
    <>
      <PageHeader
        title="Workspaces"
        description="One workspace holds exactly one research question, with its own budget, agents and evidence."
        actions={
          <LinkButton href="/workspaces/new" variant="primary">
            New workspace
          </LinkButton>
        }
      />
      <Content>
        <WorkspacesView />
      </Content>
    </>
  );
}
