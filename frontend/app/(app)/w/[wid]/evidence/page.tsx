import EvidenceView from './evidence-view';

export default async function Page({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  return <EvidenceView wid={wid} />;
}
