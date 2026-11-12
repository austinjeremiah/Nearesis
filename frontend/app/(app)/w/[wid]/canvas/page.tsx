import { Content, PageHeader } from '@/components/nx/shell';
import { LinkButton } from '@/components/nx/ui';
import CanvasView from '@/components/nx/panel/CanvasView';

/**
 * Spec 5.7 canvas. Panels come from GET /v1/workspaces/{id}/canvas; each one loads
 * its own data from the panel data route as it scrolls into view, and live events
 * (query.completed, panel.updated, canvas.patched) refresh them without a reload.
 */
export default async function Page({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  return (
    <>
      <PageHeader
        title="Canvas"
        description="Panels draw real query results with their provenance, coverage and freshness."
        crumbs={[{ label: 'Workspace', href: `/w/${wid}/overview` }, { label: 'Canvas' }]}
        actions={<LinkButton href={`/w/${wid}/investigate`}>Ask a question</LinkButton>}
      />
      <Content>
        <CanvasView wid={wid} />
      </Content>
    </>
  );
}
