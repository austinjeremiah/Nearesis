import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { LinkButton } from '@/components/nx/ui';
import { Badge } from '@/components/nx/evidence';
import { api } from '@/lib/api/server';
import { settle } from '@/lib/api/guard';
import { workspaceLabel } from '@/lib/workspace/label';
import { ApiErrorState } from '@/components/nx/states';
import OverviewView from './overview-view';

/**
 * Spec 5.5 — workspace overview. The header is rendered on the server from
 * GET /v1/workspaces/{id}; the cards below are client queries so live SSE events
 * (run state, panels, monitors, timeline) refresh them without a reload.
 */
export default async function OverviewPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const r = await settle(api.workspace(wid));
  if (!r.ok) {
    if (r.error.kind === 'not_found') notFound();
    return (
      <Content>
        <ApiErrorState error={r.error} />
      </Content>
    );
  }
  const ws = r.data;
  return (
    <>
      <PageHeader
        title={workspaceLabel(ws.objective, 90)}
        description={ws.objective.length > 90 ? ws.objective : undefined}
        crumbs={[{ label: 'Workspaces', href: '/workspaces' }, { label: workspaceLabel(ws.objective, 40) }]}
        context={
          <>
            <Badge outline>{ws.networkScope}</Badge>
            <Badge outline>v{ws.version}</Badge>
          </>
        }
        actions={
          <>
            <LinkButton href={`/w/${wid}/investigate`} variant="primary">
              Ask a question
            </LinkButton>
            <LinkButton href={`/w/${wid}/canvas`}>Open canvas</LinkButton>
          </>
        }
      />
      <Content>
        <OverviewView wid={wid} />
      </Content>
    </>
  );
}
