import { headers } from "next/headers";
import { CollabClient } from "../../../../components/collab/CollabClient";

export default async function CollabPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  await headers();
  const { workspaceId } = await params;
  return <CollabClient workspaceId={workspaceId} />;
}
