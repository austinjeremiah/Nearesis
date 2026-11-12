import ExperimentView from './experiment-view';

export default async function Page({ params }: { params: Promise<{ wid: string; experimentId: string }> }) {
  const { wid, experimentId } = await params;
  return <ExperimentView wid={wid} eid={experimentId} />;
}
