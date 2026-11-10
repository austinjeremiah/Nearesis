import { SCENARIOS, loadScenario } from "../../../../fixtures/scenarios.ts";
import type { PanelData } from "../../../../lib/types.ts";

/**
 * Panel data by query hash. Until the semantic gateway route is wired, this serves the SYNTHETIC fixture results
 * (labelled sourceLabel=SYNTHETIC in every response). It never fabricates data for an unknown hash: 404.
 */
let index: Map<string, PanelData> | null = null;
export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  if (!/^[0-9a-f]{64}$/.test(hash)) return new Response("bad hash", { status: 422 });
  index ??= new Map(SCENARIOS.flatMap((s) => Object.entries(loadScenario(s).data)));
  const d = index.get(hash);
  return d ? Response.json(d) : new Response("not found", { status: 404 });
}
