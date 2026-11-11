import { CanvasDocument } from "@nearesis/contracts";
import { previewHash, validateCanvasPatchSemantics } from "@nearesis/canvas-schema";
import { isAllowed } from "../../../../lib/server/bff-allow.ts";
import { upstream } from "../../../../lib/server/upstream.ts";

/**
 * Same-origin BFF proxy to the kernel API (/v1/...). Only the paths the canvas needs are forwarded.
 * `POST workspaces/:id/canvas/preview` is answered here: a pure validation of the patch against the current
 * persisted document (no writes, no events; C11a). It returns 422 with per-operation issues, or a stable preview hash.
 */

async function forward(req: Request, path: string[]): Promise<Response> {
  const p = path.join("/");
  const url = new URL(req.url);
  const pv = /^workspaces\/([0-9a-f-]{36})\/canvas\/preview$/.exec(p);
  if (pv && req.method === "POST") return preview(pv[1]!, await req.json());
  if (!isAllowed(p)) return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  const headers: Record<string, string> = {};
  for (const h of ["content-type", "if-match", "idempotency-key", "last-event-id", "accept"]) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  const r = await upstream(`/v1/${p}${url.search}`, {
    method: req.method,
    headers,
    body: req.method === "GET" ? undefined : await req.text(),
  });
  const out = new Headers();
  // Export files keep the API's sandbox CSP, nosniff and checksum headers.
  for (const h of [
    "content-type",
    "x-trace-id",
    "cache-control",
    "content-security-policy",
    "x-content-type-options",
    "x-capsule-sha256",
  ]) {
    const v = r.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(r.body, { status: r.status, headers: out });
}

async function preview(workspaceId: string, patch: unknown): Promise<Response> {
  const r = await upstream(`/v1/workspaces/${workspaceId}/canvas`);
  if (!r.ok) return new Response(r.body, { status: r.status });
  const doc = CanvasDocument.parse(await r.json());
  const report = validateCanvasPatchSemantics(doc, patch);
  if (!report.ok)
    return Response.json(
      {
        errorCode: "VALIDATION_FAILED",
        reasonCode: "PATCH_REJECTED",
        operations: report.operations,
        details: report.issues.map((i) => ({ path: i.path, issue: i.message })),
        lastStableRevision: doc.documentRevision,
      },
      { status: 422 },
    );
  const ops = (patch as { operations: Parameters<typeof previewHash>[1] }).operations;
  return Response.json({
    previewHash: previewHash(doc, ops),
    baseRevision: doc.documentRevision,
    operations: report.operations,
  });
}

type Ctx = { params: Promise<{ path: string[] }> };
export async function GET(req: Request, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function POST(req: Request, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
