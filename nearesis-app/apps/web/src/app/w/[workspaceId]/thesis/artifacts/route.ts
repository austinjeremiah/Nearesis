import { sessionFor } from "../../../../../lib/server/semantic.ts";
import { loadArtifacts } from "../../../../../components/thesis/server-artifacts.ts";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  if (!(await sessionFor(workspaceId))) return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  return Response.json(loadArtifacts(), { headers: { "cache-control": "no-store" } });
}
