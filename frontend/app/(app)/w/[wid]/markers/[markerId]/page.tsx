import MarkerView from './marker-view';

export default async function Page({ params }: { params: Promise<{ wid: string; markerId: string }> }) {
  const { wid, markerId } = await params;
  return <MarkerView wid={wid} markerId={markerId} />;
}
