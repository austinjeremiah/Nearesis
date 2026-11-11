import { sessionFor } from "../../../../../lib/server/semantic.ts";
import { loadCapsule } from "../../../../../components/thesis/server-artifacts.ts";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  if (!(await sessionFor(workspaceId))) return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  const id = new URL(req.url).searchParams.get("id");
  return Response.json(loadCapsule(id && /^[A-Za-z0-9._:-]{1,120}$/.test(id) ? id : null), {
    headers: { "cache-control": "no-store" },
  });
}
