import { headers } from "next/headers";
import { HistoryClient } from "../../../../components/history/HistoryClient";

export default async function HistoryPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  await headers();
  const { workspaceId } = await params;
  return <HistoryClient workspaceId={workspaceId} />;
}
