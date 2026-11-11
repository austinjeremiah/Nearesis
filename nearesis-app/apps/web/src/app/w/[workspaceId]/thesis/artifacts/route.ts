import { sessionFor } from "../../../../../lib/server/semantic.ts";
import { loadArtifacts } from "../../../../../components/thesis/server-artifacts.ts";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  if (!(await sessionFor(workspaceId))) return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  return Response.json(await loadArtifacts(new URL(req.url).searchParams.get("capsule")), {
    headers: { "cache-control": "no-store" },
  });
}
