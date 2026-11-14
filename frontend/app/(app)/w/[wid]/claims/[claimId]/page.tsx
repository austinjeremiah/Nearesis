import ClaimView from './claim-view';

export default async function Page({ params }: { params: Promise<{ wid: string; claimId: string }> }) {
  const { wid, claimId } = await params;
  return <ClaimView wid={wid} claimId={claimId} />;
}
