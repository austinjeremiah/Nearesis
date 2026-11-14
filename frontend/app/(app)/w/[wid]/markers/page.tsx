import MarkersView from './markers-view';

export default async function Page({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  return <MarkersView wid={wid} />;
}
