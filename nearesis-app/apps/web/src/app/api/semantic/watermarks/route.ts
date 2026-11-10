import { sessionFor, watermarks } from "../../../../lib/server/semantic.ts";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await sessionFor(new URL(req.url).searchParams.get("workspace") ?? "");
  if (!session) return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  return Response.json(await watermarks(), { headers: { "cache-control": "no-store" } });
}
