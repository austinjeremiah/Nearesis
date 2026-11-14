import { headers } from "next/headers";
import { WorkspaceClient } from "../../../components/WorkspaceClient";

export default async function WorkspacePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  await headers();
  const { workspaceId } = await params;
  return <WorkspaceClient workspaceId={workspaceId} />;
}
