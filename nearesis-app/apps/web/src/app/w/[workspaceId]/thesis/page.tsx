import { headers } from "next/headers";
import { ThesisClient } from "../../../../components/thesis/ThesisClient";

export default async function ThesisPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  await headers();
  const { workspaceId } = await params;
  return <ThesisClient workspaceId={workspaceId} />;
}
