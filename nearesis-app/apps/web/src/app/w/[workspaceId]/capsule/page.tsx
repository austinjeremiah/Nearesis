import { headers } from "next/headers";
import { CapsuleClient } from "../../../../components/capsule/CapsuleClient";

export default async function CapsulePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  await headers();
  const { workspaceId } = await params;
  return <CapsuleClient workspaceId={workspaceId} />;
}
