/**
 * SYNTHETIC canvas scenarios for the fixture backend (ch.00 principle 9: visibly labelled, never presented as
 * production data). Deterministic: same scenario => same document, data and hashes.
 */
import type { CanvasDocument, ChartData, PanelSpec } from "@nearesis/contracts";
import { hashCanonical, type QueryResultShape } from "@nearesis/canvas-schema";
import type { GraphProjection, PanelData } from "../lib/types.ts";

export const SCENARIOS = [
  "baseline",
  "hostile",
  "large",
  "corrupt",
  "graph",
  "gaps",
  "empty",
  "visuals",
] as const;
export type ScenarioId = (typeof SCENARIOS)[number];

export interface Scenario {
  id: ScenarioId;
  document: unknown;
  data: Record<string, PanelData>;
  graph: GraphProjection | null;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);
const iso = (t: number) => new Date(t).toISOString();
const SNAPSHOT = "fx.snapshot.p02-baseline";
const MODEL_HASH = hashCanonical({ fixture: "semantic-model", version: "1.0.0" });

interface QueryDef {
  measures: string[];
  dimensions?: string[];
  grain?: "day" | "week";
  from?: string;
  to?: string;
}
function ast(q: QueryDef) {
  return {
    semanticVersion: "1.0.0",
    measures: q.measures,
    dimensions: q.dimensions ?? [],
    time: {
      field: "intents.day",
      from: q.from ?? iso(T0),
      to: q.to ?? iso(T0 + 40 * DAY),
      grain: q.grain ?? "day",
    },
    filters: [],
    order: [],
    limit: 10000,
    sourceSnapshotId: SNAPSHOT,
  };
}

function makeData(
  q: QueryDef,
  shape: Omit<QueryResultShape, "queryHash">,
  columns: ChartData["columns"],
  rows: ChartData["rows"],
  opts: {
    gaps?: PanelData["gaps"];
    freshness?: ChartData["freshness"];
    sources?: string[];
    method?: ChartData["downsampling"]["method"];
  } = {},
): { hash: string; data: PanelData } {
  const a = ast(q);
  const hash = hashCanonical(a);
  const resultHash = hashCanonical({ columns, rows });
  return {
    hash,
    data: {
      chart: {
        panelId: uuid(0),
        queryHash: hash,
        dataRevision: 1,
        columns,
        rows,
        downsampling: { method: opts.method ?? "none", originalPoints: rows.length },
        freshness: opts.freshness ?? "fresh",
        sourceWatermark: "2026-11-09T23:59:59.000Z",
      },
      shape: { queryHash: hash, ...shape },
      provenance: {
        queryHash: hash,
        semanticVersion: "1.0.0",
        semanticModelHash: MODEL_HASH,
        sourceSnapshotId: SNAPSHOT,
        rawManifestHash: hashCanonical({ snapshot: SNAPSHOT }),
        certification: opts.gaps?.length ? "partial" : "certified",
        ast: a,
        sourceLabel: "SYNTHETIC",
        resultHash,
        sources: opts.sources ?? ["near-explorer"],
      },
      gaps: opts.gaps ?? [],
    },
  };
}

function panel(
  n: number,
  hash: string,
  over: Partial<PanelSpec> & Pick<PanelSpec, "kind" | "title" | "dataBinding" | "encoding">,
): PanelSpec {
  return {
    panelId: uuid(n),
    schemaVersion: 1,
    queryRef: { hash, semanticVersion: "1.0.0", snapshotPolicy: "live" },
    layout: { x: ((n - 1) % 2) * 6, y: Math.floor((n - 1) / 2) * 6, w: 6, h: 6 },
    refreshPolicy: { mode: "on_watermark" },
    provenanceRequired: true,
    ...over,
  };
}

function doc(panels: unknown[], extra: Partial<CanvasDocument> = {}): unknown {
  return {
    id: uuid(9001),
    workspaceId: uuid(9002),
    branchId: uuid(9003),
    documentRevision: 1,
    dataRevision: 1,
    viewport: { zoom: 1, x: 0, y: 0 },
    layoutMode: "grid",
    panels,
    markers: [],
    activeSelections: [],
    updatedAt: "2026-11-10T00:00:00.000Z",
    ...extra,
  };
}

const TIME_FIELD = {
  name: "intents.day",
  unit: null,
  role: "time" as const,
  timeSemantics: "event_time" as const,
};

/** Daily swap counts with a provider gap on 2026-10-15 (null, never 0) and a confirmed zero day. */
function swaps() {
  const rows: ChartData["rows"] = [];
  for (let d = 0; d < 40; d++) {
    const t = T0 + d * DAY;
    const day = iso(t);
    if (day.startsWith("2026-10-15")) rows.push([day, null]);
    else if (day.startsWith("2026-10-03")) rows.push([day, 0]);
    else rows.push([day, 120 + ((d * 37) % 50) + (t >= Date.UTC(2026, 9, 27) ? 30 : 0)]);
  }
  return makeData(
    { measures: ["intents.swap_count"] },
    {
      grain: "day",
      fields: [
        TIME_FIELD,
        { name: "intents.swap_count", unit: "count", role: "measure", metricId: "intents.swap_count" },
      ],
    },
    [
      { name: "intents.day", unit: null },
      { name: "intents.swap_count", unit: "count" },
    ],
    rows,
    { gaps: [{ from: "2026-10-15T00:00:00.000Z", to: "2026-10-16T00:00:00.000Z", reason: "PROVIDER_GAP" }] },
  );
}

function volume() {
  const rows: ChartData["rows"] = [];
  for (let d = 0; d < 40; d++)
    rows.push([iso(T0 + d * DAY), `${(250000 + ((d * 7919) % 90000)).toString()}.25`]);
  return makeData(
    { measures: ["intents.volume_usd"] },
    {
      grain: "day",
      fields: [
        TIME_FIELD,
        { name: "intents.volume_usd", unit: "usd", role: "measure", metricId: "intents.volume_usd" },
      ],
    },
    [
      { name: "intents.day", unit: null },
      { name: "intents.volume_usd", unit: "usd" },
    ],
    rows,
  );
}

function byChain(labels: string[]) {
  const rows: ChartData["rows"] = labels.map((l, i) => [l, 1000 - i * 90]);
  return makeData(
    { measures: ["intents.swap_count"], dimensions: ["intents.chain"] },
    {
      grain: "day",
      fields: [
        { name: "intents.chain", unit: null, role: "dimension" },
        { name: "intents.swap_count", unit: "count", role: "measure", metricId: "intents.swap_count" },
      ],
    },
    [
      { name: "intents.chain", unit: null },
      { name: "intents.swap_count", unit: "count" },
    ],
    rows,
  );
}

function notePanel(n: number, title: string, note: string): PanelSpec {
  const h = hashCanonical({ note: n });
  return panel(n, h, {
    kind: "note",
    title,
    note,
    dataBinding: { fields: ["note"], units: {}, timezone: "UTC", completeness: "complete" },
    encoding: { interpolateGaps: false },
  });
}

function baseline(): Scenario {
  const s = swaps();
  const v = volume();
  const c = byChain(["near", "eth", "sol", "base", "arb", "btc"]);
  const panels = [
    panel(1, s.hash, {
      kind: "timeSeries",
      title: "Completed 1Click swaps per UTC day",
      dataBinding: {
        fields: ["intents.day", "intents.swap_count"],
        units: { "intents.swap_count": "count" },
        timezone: "UTC",
        completeness: "partial",
      },
      encoding: { x: "intents.day", y: ["intents.swap_count"], interpolateGaps: false },
    }),
    panel(2, v.hash, {
      kind: "timeSeries",
      title: "1Click volume (USD) per UTC day",
      dataBinding: {
        fields: ["intents.day", "intents.volume_usd"],
        units: { "intents.volume_usd": "usd" },
        timezone: "UTC",
        completeness: "complete",
      },
      encoding: { x: "intents.day", y: ["intents.volume_usd"], interpolateGaps: false },
    }),
    panel(3, c.hash, {
      kind: "bar",
      title: "Swaps by origin chain",
      dataBinding: {
        fields: ["intents.chain", "intents.swap_count"],
        units: { "intents.swap_count": "count" },
        timezone: "UTC",
        completeness: "complete",
      },
      encoding: { x: "intents.chain", y: ["intents.swap_count"], interpolateGaps: false },
    }),
    notePanel(
      4,
      "Observability note",
      "**Private settlement from 2026-10-27.** Public `nearTxHashes` are shield/unshield hashes, not swaps.\n\n- Explorer covers 1Click only\n- Missing days are gaps, not zeros",
    ),
  ];
  return {
    id: "baseline",
    document: doc(panels),
    data: { [s.hash]: s.data, [v.hash]: v.data, [c.hash]: c.data },
    graph: null,
  };
}

/** C10 payloads: every one must render as inert text. */
export const HOSTILE = [
  "<script>window.__xss=1</script>",
  '<img src=x onerror="window.__xss=1">',
  "javascript:window.__xss=1",
  '<svg onload="window.__xss=1"></svg>',
  '<div style="background:url(javascript:window.__xss=1);width:expression(window.__xss=1)">css</div>',
  "‮gnp.exe‬ RTL override",
  "${window.__xss=1}",
  "{@html window.__xss=1}",
  "function(params){window.__xss=1;return params}",
  '"><iframe src="javascript:window.__xss=1"></iframe>',
  '<a href="javascript:window.__xss=1">click</a>',
  "{{constructor.constructor('window.__xss=1')()}}",
  '<math><mi xlink:href="javascript:window.__xss=1">x</mi></math>',
  '<details open ontoggle="window.__xss=1">',
  "<body onload=window.__xss=1>",
];

function hostile(): Scenario {
  const c = byChain(HOSTILE);
  const s = swaps();
  const panels = [
    panel(1, c.hash, {
      kind: "bar",
      title: HOSTILE[0]!,
      dataBinding: {
        fields: ["intents.chain", "intents.swap_count"],
        units: { "intents.swap_count": "count" },
        timezone: "UTC",
        completeness: "complete",
      },
      encoding: {
        x: "intents.chain",
        y: ["intents.swap_count"],
        tooltip: ["intents.chain"],
        interpolateGaps: false,
      },
    }),
    panel(2, s.hash, {
      kind: "timeSeries",
      title: HOSTILE[1]!,
      dataBinding: {
        fields: ["intents.day", "intents.swap_count"],
        units: { "intents.swap_count": HOSTILE[2]!.slice(0, 40) },
        timezone: "UTC",
        completeness: "partial",
      },
      encoding: { x: "intents.day", y: ["intents.swap_count"], interpolateGaps: false },
    }),
    panel(3, c.hash, {
      kind: "table",
      title: HOSTILE[3]!,
      dataBinding: {
        fields: ["intents.chain", "intents.swap_count"],
        units: { "intents.swap_count": "count" },
        timezone: "UTC",
        completeness: "complete",
      },
      encoding: { interpolateGaps: false },
    }),
    notePanel(
      4,
      HOSTILE[9]!.slice(0, 180),
      HOSTILE.map((h, i) => `- payload ${i}: ${h}\n- [link ${i}](${h})`).join("\n") +
        "\n\n```\n" +
        HOSTILE.join("\n") +
        "\n```",
    ),
  ];
  return { id: "hostile", document: doc(panels), data: { [c.hash]: c.data, [s.hash]: s.data }, graph: null };
}

/** C18: 100k-point series with known spikes, plus a 50k-point scatter. */
function large(): Scenario {
  const N = 100_000;
  const rows: ChartData["rows"] = new Array(N);
  const start = Date.UTC(2026, 8, 1);
  for (let i = 0; i < N; i++)
    rows[i] = [start + i * 60_000, Math.round(1000 + 200 * Math.sin(i / 300) + ((i * 7919) % 97))];
  rows[31_337] = [start + 31_337 * 60_000, 9999];
  rows[77_777] = [start + 77_777 * 60_000, -500];
  const ts = makeData(
    { measures: ["quotes.cost_bps"], from: iso(start), to: iso(start + N * 60_000) },
    {
      grain: "day",
      fields: [
        { name: "quotes.fetched_at", unit: null, role: "time", timeSemantics: "fetched_at" },
        { name: "quotes.cost_bps", unit: "bps", role: "measure", metricId: "quotes.cost_bps" },
      ],
    },
    [
      { name: "quotes.fetched_at", unit: null },
      { name: "quotes.cost_bps", unit: "bps" },
    ],
    rows,
    { sources: ["intents-1click"] },
  );
  const M = 50_000;
  const sc: ChartData["rows"] = new Array(M);
  for (let i = 0; i < M; i++) sc[i] = [((i * 7919) % 10007) / 10, ((i * 104729) % 9973) / 10];
  const scatter = makeData(
    { measures: ["quotes.amount_usd", "quotes.cost_bps"], dimensions: ["quotes.route"] },
    {
      grain: "day",
      fields: [
        { name: "quotes.amount_usd", unit: "usd", role: "measure" },
        { name: "quotes.cost_bps", unit: "bps", role: "measure" },
      ],
    },
    [
      { name: "quotes.amount_usd", unit: "usd" },
      { name: "quotes.cost_bps", unit: "bps" },
    ],
    sc,
    { sources: ["intents-1click"] },
  );
  const panels = [
    panel(1, ts.hash, {
      kind: "timeSeries",
      title: "Route quote cost (100k samples)",
      layout: { x: 0, y: 0, w: 12, h: 6 },
      dataBinding: {
        fields: ["quotes.fetched_at", "quotes.cost_bps"],
        units: { "quotes.cost_bps": "bps" },
        timezone: "UTC",
        completeness: "complete",
      },
      encoding: { x: "quotes.fetched_at", y: ["quotes.cost_bps"], interpolateGaps: false },
    }),
    panel(2, scatter.hash, {
      kind: "scatter",
      title: "Quote cost vs size (50k samples)",
      layout: { x: 0, y: 6, w: 12, h: 6 },
      dataBinding: {
        fields: ["quotes.amount_usd", "quotes.cost_bps"],
        units: { "quotes.amount_usd": "usd", "quotes.cost_bps": "bps" },
        timezone: "UTC",
        completeness: "complete",
      },
      encoding: { x: "quotes.amount_usd", y: ["quotes.cost_bps"], interpolateGaps: false },
    }),
  ];
  return {
    id: "large",
    document: doc(panels),
    data: { [ts.hash]: ts.data, [scatter.hash]: scatter.data },
    graph: null,
  };
}

/** C09b: one stored panel is corrupted (unknown kind, extra field); the others must still render. */
function corrupt(): Scenario {
  const b = baseline();
  const d = b.document as { panels: Array<Record<string, unknown>> };
  d.panels[1] = { ...d.panels[1], kind: "sankey3d", renderer: "customReact" };
  return { ...b, id: "corrupt" };
}

function gaps(): Scenario {
  const b = baseline();
  const d = b.document as { panels: unknown[] };
  return { ...b, id: "gaps", document: doc([d.panels[0]]) };
}

function empty(): Scenario {
  const e = makeData(
    { measures: ["intents.swap_count"], from: "2026-11-09T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z" },
    {
      grain: "day",
      fields: [
        TIME_FIELD,
        { name: "intents.swap_count", unit: "count", role: "measure", metricId: "intents.swap_count" },
      ],
    },
    [
      { name: "intents.day", unit: null },
      { name: "intents.swap_count", unit: "count" },
    ],
    [],
  );
  const p = panel(1, e.hash, {
    kind: "timeSeries",
    title: "Swaps (window with no rows)",
    dataBinding: {
      fields: ["intents.day", "intents.swap_count"],
      units: { "intents.swap_count": "count" },
      timezone: "UTC",
      completeness: "complete",
    },
    encoding: { x: "intents.day", y: ["intents.swap_count"], interpolateGaps: false },
  });
  return { id: "empty", document: doc([p]), data: { [e.hash]: e.data }, graph: null };
}

/** C16: 1 hypothesis, 4 queries, 2 sources, 1 marker, 4 agents, 12 valid edges + 2 invalid. */
function graph(): Scenario {
  const b = baseline();
  const nodes: GraphProjection["nodes"] = [
    { id: "h1", type: "hypothesis", label: "Private settlement did not reduce 1Click activity" },
    ...[1, 2, 3, 4].map((i) => ({ id: `q${i}`, type: "query", label: `Panel ${i} query` })),
    { id: "s1", type: "source", label: "NEAR Intents Explorer" },
    { id: "s2", type: "source", label: "NEAR BigQuery" },
    { id: "m1", type: "marker", label: "2026-10-27 regime change" },
    ...["scout", "statistics", "skeptic", "auditor"].map((r, i) => ({
      id: `a${i + 1}`,
      type: "agent",
      label: `${r} agent`,
    })),
  ];
  nodes.forEach((n, i) => (n.position = { x: (i % 4) * 220, y: Math.floor(i / 4) * 140 }));
  const rel = (id: string, source: string, target: string, relation: string) => ({
    id,
    source,
    target,
    relation,
  });
  const edges: GraphProjection["edges"] = [
    rel("e1", "q1", "h1", "supports"),
    rel("e2", "q2", "h1", "supports"),
    rel("e3", "q3", "h1", "contradicts"),
    rel("e4", "q4", "h1", "references"),
    rel("e5", "q1", "s1", "derived_from"),
    rel("e6", "q2", "s1", "derived_from"),
    rel("e7", "q3", "s2", "derived_from"),
    rel("e8", "q4", "s2", "derived_from"),
    rel("e9", "m1", "q1", "references"),
    rel("e10", "a1", "m1", "monitors"),
    rel("e11", "a3", "q3", "reproduces"),
    rel("e12", "a4", "q1", "reproduces"),
    rel("e13", "a2", "q2", "owns"),
    rel("e14", "a2", "ghost", "supports"),
  ];
  const d = b.document as { panels: unknown[] };
  const gp = panel(5, hashCanonical({ graph: 1 }), {
    kind: "evidenceGraph",
    title: "Evidence graph",
    layout: { x: 0, y: 12, w: 12, h: 8 },
    dataBinding: { fields: ["graph"], units: {}, timezone: "UTC", completeness: "complete" },
    encoding: { interpolateGaps: false },
  });
  return { ...b, id: "graph", document: doc([...d.panels, gp]), graph: { nodes, edges } };
}

/** OHLC daily candles: low <= min(open, close) and high >= max(open, close) by construction. */
function candles() {
  const rows: ChartData["rows"] = [];
  let prev = 4.1;
  for (let d = 0; d < 30; d++) {
    const open = prev;
    const close = Math.round((open + Math.sin(d / 3) * 0.12 + ((d * 13) % 7) * 0.01 - 0.03) * 1000) / 1000;
    const low = Math.round((Math.min(open, close) - 0.05) * 1000) / 1000;
    const high = Math.round((Math.max(open, close) + 0.06) * 1000) / 1000;
    rows.push([iso(T0 + d * DAY), open, close, low, high]);
    prev = close;
  }
  const num = (name: string) => ({ name, unit: "usd", role: "measure" as const, metricId: name });
  return makeData(
    { measures: ["near.open", "near.close", "near.low", "near.high"] },
    {
      grain: "day",
      fields: [TIME_FIELD, num("near.open"), num("near.close"), num("near.low"), num("near.high")],
    },
    [
      { name: "intents.day", unit: null },
      { name: "near.open", unit: "usd" },
      { name: "near.close", unit: "usd" },
      { name: "near.low", unit: "usd" },
      { name: "near.high", unit: "usd" },
    ],
    rows,
  );
}

/** Chain x weekday swap counts; one cell is unknown (null), never 0. */
function heat() {
  const chains = ["near", "eth", "sol", "base"];
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const rows: ChartData["rows"] = [];
  chains.forEach((c, ci) =>
    days.forEach((d, di) => rows.push([d, c, ci === 2 && di === 3 ? null : 40 + ((ci * 31 + di * 17) % 90)])),
  );
  return makeData(
    { measures: ["intents.swap_count"], dimensions: ["intents.weekday", "intents.chain"] },
    {
      grain: "day",
      fields: [
        { name: "intents.weekday", unit: null, role: "dimension" },
        { name: "intents.chain", unit: null, role: "dimension" },
        { name: "intents.swap_count", unit: "count", role: "measure", metricId: "intents.swap_count" },
      ],
    },
    [
      { name: "intents.weekday", unit: null },
      { name: "intents.chain", unit: null },
      { name: "intents.swap_count", unit: "count" },
    ],
    rows,
  );
}

function visuals(): Scenario {
  const k = candles();
  const h = heat();
  const s = swaps();
  const panels = [
    panel(1, k.hash, {
      kind: "candlestick",
      title: "NEAR daily candles (USD)",
      dataBinding: {
        fields: ["intents.day", "near.open", "near.close", "near.low", "near.high"],
        units: { "near.open": "usd", "near.close": "usd", "near.low": "usd", "near.high": "usd" },
        timezone: "UTC",
        completeness: "complete",
      },
      encoding: {
        x: "intents.day",
        y: ["near.open", "near.close", "near.low", "near.high"],
        interpolateGaps: false,
      },
    }),
    panel(2, h.hash, {
      kind: "heatmap",
      title: "Swaps by chain and weekday",
      dataBinding: {
        fields: ["intents.weekday", "intents.chain", "intents.swap_count"],
        units: { "intents.swap_count": "count" },
        timezone: "UTC",
        completeness: "partial",
      },
      encoding: {
        x: "intents.weekday",
        y: ["intents.swap_count"],
        series: "intents.chain",
        interpolateGaps: false,
      },
    }),
    panel(3, s.hash, {
      kind: "timeSeries",
      title: "Completed 1Click swaps per UTC day",
      dataBinding: {
        fields: ["intents.day", "intents.swap_count"],
        units: { "intents.swap_count": "count" },
        timezone: "UTC",
        completeness: "partial",
      },
      encoding: { x: "intents.day", y: ["intents.swap_count"], interpolateGaps: false },
    }),
  ];
  return {
    id: "visuals",
    document: doc(panels),
    data: { [k.hash]: k.data, [h.hash]: h.data, [s.hash]: s.data },
    graph: null,
  };
}

export function loadScenario(id: string): Scenario {
  switch (id) {
    case "visuals":
      return visuals();
    case "hostile":
      return hostile();
    case "large":
      return large();
    case "corrupt":
      return corrupt();
    case "graph":
      return graph();
    case "gaps":
      return gaps();
    case "empty":
      return empty();
    default:
      return baseline();
  }
}
