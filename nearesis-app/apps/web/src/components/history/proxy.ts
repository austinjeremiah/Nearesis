/**
 * Server-only proxy for the evidence and time-machine pages. The shared BFF allowlist (lib/server/bff-allow.ts) does
 * not include the history routes; until it does (queue request), these pages forward a narrow, explicit set of
 * kernel paths for the route's own workspace. The kernel enforces membership; foreign ids get its identical 404.
 */
import { upstream } from "../../lib/server/upstream.ts";

const UUID = "[0-9a-f-]{36}";
export const HISTORY_PATHS: RegExp[] = [
  /^snapshots$/,
  /^snapshots\/compare$/,
  new RegExp(`^snapshots/${UUID}(/(canvas|graph|layout))?$`),
  /^timeline$/,
  /^branches$/,
  new RegExp(`^branches/${UUID}(/(diff|changes))?$`),
  /^merge-proposals$/,
  new RegExp(`^merge-proposals/${UUID}(/(resolve|accept|reject))?$`),
];
export const EVIDENCE_PATHS: RegExp[] = [/^graph$/, /^graph\/rechecks$/, /^graph\/rechecks\/resolve$/];

export async function forwardScoped(
  req: Request,
  workspaceId: string,
  path: string[],
  allowed: RegExp[],
): Promise<Response> {
  const sub = path.join("/");
  if (!new RegExp(`^${UUID}$`).test(workspaceId) || !allowed.some((r) => r.test(sub)))
    return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  if (req.method !== "GET" && req.method !== "POST")
    return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  for (const h of ["content-type", "if-match", "idempotency-key", "accept"]) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  const r = await upstream(`/v1/workspaces/${workspaceId}/${sub}${url.search}`, {
    method: req.method,
    headers,
    body: req.method === "GET" ? undefined : await req.text(),
  });
  const out = new Headers({ "cache-control": "no-store" });
  for (const h of ["content-type", "x-trace-id"]) {
    const v = r.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(r.body, { status: r.status, headers: out });
}
