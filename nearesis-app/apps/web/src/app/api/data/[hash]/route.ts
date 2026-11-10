import { SCENARIOS, loadScenario } from "../../../../fixtures/scenarios.ts";
import type { PanelData } from "../../../../lib/types.ts";

/**
 * Panel data by query hash. Until the semantic gateway route is wired, this serves the SYNTHETIC fixture results
 * (labelled sourceLabel=SYNTHETIC in every response). It never fabricates data for an unknown hash: 404.
 */
let index: Map<string, PanelData> | null = null;
export async function GET(req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  if (!/^[0-9a-f]{64}$/.test(hash)) return new Response("bad hash", { status: 422 });
  index ??= new Map(SCENARIOS.flatMap((s) => Object.entries(loadScenario(s).data)));
  const d = index.get(hash);
  if (!d) return new Response("not found", { status: 404 });
  const vintage = Number(new URL(req.url).searchParams.get("vintage") ?? "1");
  return Response.json(vintage > 1 ? revise(d, vintage) : d);
}

/** Later data vintage (SYNTHETIC): 3 new days appended and one existing value revised (C12 refresh fixture). */
function revise(d: PanelData, vintage: number): PanelData {
  const c = structuredClone(d);
  const rows = c.chart.rows;
  const last = rows[rows.length - 1];
  if (!last || typeof last[0] !== "string" || Number.isNaN(Date.parse(last[0]))) return c;
  for (let i = 1; i <= 3; i++) {
    const t = new Date(Date.parse(last[0]) + i * 86_400_000).toISOString();
    rows.push([t, ...last.slice(1).map((v) => (typeof v === "number" ? v + 7 * i : v))]);
  }
  const k = Math.min(10, rows.length - 1);
  rows[k] = rows[k]!.map((v, j) => (j > 0 && typeof v === "number" ? v + 41 : v));
  c.chart.dataRevision = d.chart.dataRevision + vintage - 1;
  c.chart.downsampling = { ...c.chart.downsampling, originalPoints: rows.length };
  c.chart.sourceWatermark = new Date(Date.parse(last[0]) + 3 * 86_400_000).toISOString();
  return c;
}
