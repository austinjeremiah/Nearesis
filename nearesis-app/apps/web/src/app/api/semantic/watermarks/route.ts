import { parseSource, sessionFor, watermarks } from "../../../../lib/server/semantic.ts";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await sessionFor(new URL(req.url).searchParams.get("workspace") ?? "");
  if (!session) return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  const source = parseSource(new URL(req.url).searchParams.get("source"));
  // The live layer may be down or empty: report no watermarks rather than inventing freshness.
  const wm = source === "live" ? await watermarks(source).catch(() => ({})) : await watermarks(source);
  return Response.json(wm, { headers: { "cache-control": "no-store" } });
}
