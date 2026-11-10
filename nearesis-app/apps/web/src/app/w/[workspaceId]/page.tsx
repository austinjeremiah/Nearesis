import { headers } from "next/headers";
import { Workspace } from "../../../components/Workspace";

export default async function WorkspacePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  await headers();
  const { workspaceId } = await params;
  return <Workspace workspaceId={workspaceId} />;
}
