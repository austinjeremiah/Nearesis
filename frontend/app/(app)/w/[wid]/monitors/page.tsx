import MonitorsView from './monitors-view';

export default async function Page({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  return <MonitorsView wid={wid} />;
}
