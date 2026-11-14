import { Content } from '@/components/nx/shell';
import { BracketButton, PageHero } from '@/components/nx/landing';
import WorkspacesView from './workspaces-view';

/**
 * Spec 5.3 — workspace portfolio, backed by GET /v1/workspaces. A table by
 * default, because density matters more than card decoration when the
 * question is "which of my investigations needs me".
 */
export default function WorkspacesPage() {
  return (
    <>
      <PageHero
        kicker="Portfolio"
        title="Workspaces"
        lede="One workspace holds exactly one research question, with its own budget, agents and evidence."
        actions={<BracketButton href="/workspaces/new">New workspace</BracketButton>}
      />
      <Content>
        <WorkspacesView />
      </Content>
    </>
  );
}
