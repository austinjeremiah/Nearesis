import { sessionToken } from "../../../lib/server/upstream.ts";

/** The signed-in user as far as the BFF knows it: the verified token subject (the API issues no profile yet). */
export async function GET() {
  const token = await sessionToken();
  if (!token) return Response.json({ errorCode: "UNAUTHENTICATED" }, { status: 401 });
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      sub?: string;
    };
    return Response.json({ subject: p.sub ?? null }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ errorCode: "UNAUTHENTICATED" }, { status: 401 });
  }
}
