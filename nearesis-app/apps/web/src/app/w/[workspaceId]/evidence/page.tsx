import { headers } from "next/headers";
import { EvidenceClient } from "../../../../components/evidence/EvidenceClient";

export default async function EvidencePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  await headers();
  const { workspaceId } = await params;
  return <EvidenceClient workspaceId={workspaceId} />;
}
