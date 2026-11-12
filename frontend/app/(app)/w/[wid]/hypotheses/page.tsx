import HypothesesView from './hypotheses-view';

export default async function Page({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  return <HypothesesView wid={wid} />;
}
