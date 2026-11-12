import { Content, PageHeader } from '@/components/nx/shell';
import { LinkButton } from '@/components/nx/ui';
import PanelDetail from '@/components/nx/panel/PanelDetail';

export default async function Page({ params }: { params: Promise<{ wid: string; panelId: string }> }) {
  const { wid, panelId } = await params;
  return (
    <>
      <PageHeader
        title="Panel"
        description="The chart, its rows, the exact query and where the numbers came from."
        crumbs={[{ label: 'Canvas', href: `/w/${wid}/canvas` }, { label: 'Panel' }]}
        actions={<LinkButton href={`/w/${wid}/canvas`}>Back to canvas</LinkButton>}
      />
      <Content>
        <PanelDetail wid={wid} panelId={panelId} />
      </Content>
    </>
  );
}
