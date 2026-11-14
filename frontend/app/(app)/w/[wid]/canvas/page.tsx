import { Content, PageHeader } from '@/components/nx/shell';
import { AskOpenButton } from '@/components/nx/ask-open-button';
import { api } from '@/lib/api/server';
import { settle } from '@/lib/api/guard';
import { workspaceLabel } from '@/lib/workspace/label';
import CanvasView from '@/components/nx/panel/CanvasView';

/**
 * Spec 5.7 canvas. Panels come from GET /v1/workspaces/{id}/canvas; each one loads
 * its own data from the panel data route as it scrolls into view, and live events
 * (query.completed, panel.updated, canvas.patched) refresh them without a reload.
 */
export default async function Page({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const r = await settle(api.workspace(wid));
  const label = r.ok ? workspaceLabel(r.data.objective, 40) : 'Workspace';
  return (
    <>
      <PageHeader
        title="Canvas"
        description="Panels draw real query results with their provenance, coverage and freshness."
        crumbs={[{ label: 'Workspaces', href: '/workspaces' }, { label, href: `/w/${wid}/overview` }, { label: 'Canvas' }]}
        actions={<AskOpenButton />}
      />
      <Content>
        <CanvasView wid={wid} />
      </Content>
    </>
  );
}
