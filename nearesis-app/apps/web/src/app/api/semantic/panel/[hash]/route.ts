import { panelData, sessionFor } from "../../../../../lib/server/semantic.ts";

export const runtime = "nodejs";

/** Gateway-backed panel data: hash -> recorded AST -> guarded semantic query with a server-bound session. */
export async function GET(req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  if (!/^[0-9a-f]{64}$/.test(hash)) return Response.json({ errorCode: "VALIDATION_FAILED" }, { status: 422 });
  const session = await sessionFor(new URL(req.url).searchParams.get("workspace") ?? "");
  if (!session) return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  const r = await panelData(session, hash);
  return Response.json(r.body, { status: r.status });
}
