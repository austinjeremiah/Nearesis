import ExperimentsView from './experiments-view';

export default async function Page({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  return <ExperimentsView wid={wid} />;
}
