import { API_URL, SESSION_COOKIE, testHooksEnabled } from "../../../../lib/server/upstream.ts";

/** Dev/test login: exchanges an OIDC subject for a kernel session token stored in an HttpOnly cookie. */
export async function POST(req: Request) {
  if (!testHooksEnabled()) return new Response("not found", { status: 404 });
  const { subject } = (await req.json()) as { subject?: string };
  const r = await fetch(`${API_URL}/v1/dev/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ oidcSubject: subject }),
  });
  if (!r.ok) return new Response(await r.text(), { status: r.status });
  const { token } = (await r.json()) as { token: string };
  const res = new Response(null, { status: 204 });
  res.headers.append("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`);
  return res;
}
