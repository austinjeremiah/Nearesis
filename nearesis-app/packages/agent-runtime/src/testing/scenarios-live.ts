import type { Plan } from "../schemas.ts";
import type { ScriptRule } from "./scripted-provider.ts";
import { child } from "./scenarios.ts";

/**
 * Scripted (mock-labelled) inference for runs submitted with `source: "live"`: the analyst and the composer ask the
 * near-thesis plugin for the LIVE certified metric (cube-live, read-only), so every query, result and panel in the run
 * comes from the real-data layer. Only the model's decisions are scripted; no tool result is.
 */
export const LIVE_SCENARIO = "P10-LIVE";
export const LIVE_METRIC = "live.near_tx_count";
export const LIVE_TIME_FIELD = "near_daily_tx_live.day";
export const LIVE_PANEL_ID = "7a3b1c52-0d4e-4f6a-8b19-3c5d7e9f1a24";

export const liveQuery = () => ({
  semanticVersion: "1.0.0",
  measures: [LIVE_METRIC],
  dimensions: [] as string[],
  time: {
    field: LIVE_TIME_FIELD,
    from: "2026-10-01T00:00:00Z",
    to: "2026-11-01T00:00:00Z",
    grain: "day" as const,
  },
  filters: [] as never[],
  order: [] as never[],
  limit: 1000,
});
export const liveVizRequests = () => [
  {
    panelId: LIVE_PANEL_ID,
    title: "NEAR transactions per day (live)",
    mark: "line",
    query: liveQuery(),
    x: LIVE_TIME_FIELD,
    y: [LIVE_METRIC],
    layout: { x: 0, y: 0, w: 6, h: 6 },
  },
];

export function livePlan(scn: string): Plan {
  return {
    question: `question ${scn}`,
    modelVersion: "scripted-1",
    requiredMetrics: [LIVE_METRIC],
    needsHumanInput: false,
    privilegedAction: {
      kind: "canvas.apply_patch",
      params: { requests: liveVizRequests() } as Record<string, unknown>,
      network: "fixture-only",
      costLimit: 0,
    },
    estimatedCost: { tokens: 60000, toolCalls: 200, usd: 5 },
    stages: [
      [
        child(scn, "semantic_analyst", "measure live NEAR activity"),
        child(scn, "composer", "propose live activity panel"),
      ],
    ],
  };
}

const has = (p: string, ...needles: string[]) => needles.every((n) => p.includes(n));

/** Peak daily value, read from the literal cells of the step-1 query observation. */
function peak(p: string): { value: string; column: string } {
  const m = /step 1 semantic\.query@1 -> <untrusted_data[^>]*>\n([\s\S]*?)\n<\/untrusted_data>/.exec(p);
  const payload = JSON.parse(m![1]!) as {
    envelope: {
      columns: Array<{ name: string; type?: string }>;
      rows: Array<Array<string | number | null>>;
    };
  };
  const col = payload.envelope.columns.findIndex((c) => c.name !== LIVE_TIME_FIELD && c.type !== "time");
  let best: number | null = null;
  for (const r of payload.envelope.rows) {
    const v = r[col];
    if (typeof v === "number" && (best === null || v > best)) best = v;
  }
  if (best === null) throw new Error("no numeric cell in the live query result");
  return { value: String(best), column: payload.envelope.columns[col]!.name };
}

export function liveScenarioRules(): ScriptRule[] {
  const live = (p: string) => p.includes(`[scenario=${LIVE_SCENARIO}]`);
  const R = (match: (p: string) => boolean, respond: (p: string) => unknown): ScriptRule => ({
    match: (r) => match(r.prompt),
    respond: (r) => respond(r.prompt),
  });
  return [
    R(
      (p) => live(p) && has(p, "[role=semantic_analyst]", "[step=0]"),
      () => ({ action: "tool", tool: "semantic.discover@1", input: {} }),
    ),
    R(
      (p) => live(p) && has(p, "[role=semantic_analyst]", "[step=1]"),
      () => ({ action: "tool", tool: "semantic.query@1", input: liveQuery() }),
    ),
    R(
      (p) => live(p) && has(p, "[role=semantic_analyst]", "[step=2]"),
      (p) => {
        const pk = peak(p);
        return {
          action: "finish",
          status: "supported",
          statement: `NEAR transactions peaked at ${pk.value} per day in the queried window.`,
          facts: [{ value: pk.value, unit: "tx", sourceStep: 1, column: pk.column }],
          limitations: ["window and certification as returned by the live semantic layer"],
        };
      },
    ),
    R(
      (p) => live(p) && has(p, "[role=composer]", "[step=0]"),
      () => ({
        action: "tool",
        tool: "canvas.preview@1",
        input: { expectedRevision: 0, requests: liveVizRequests() },
      }),
    ),
    R(
      (p) => live(p) && has(p, "[role=composer]", "[step=1]"),
      () => ({
        action: "finish",
        status: "supported",
        statement: "Panel proposal is consistent with validated live result envelopes.",
        facts: [],
        limitations: [],
      }),
    ),
  ];
}
