import { EVIDENCE_PATHS, forwardScoped } from "../../../../../../components/history/proxy.ts";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ workspaceId: string; path: string[] }> };

export async function GET(req: Request, ctx: Ctx) {
  const { workspaceId, path } = await ctx.params;
  return forwardScoped(req, workspaceId, path, EVIDENCE_PATHS);
}
export async function POST(req: Request, ctx: Ctx) {
  const { workspaceId, path } = await ctx.params;
  return forwardScoped(req, workspaceId, path, EVIDENCE_PATHS);
}
