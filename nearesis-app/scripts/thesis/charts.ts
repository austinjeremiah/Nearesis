import { sha256Hex } from "../../packages/plugin-sdk/src/canonical.ts";
import { fmt, fmtPct, Ledger } from "./ground.ts";
import type { Inputs, ManifestDataset, RawFile } from "./inputs.ts";

export interface ChartQuery {
  datasetId: string;
  sqlExecuted: string | null;
  sqlBigQuery: string | null;
  bigQueryExecuted: boolean;
  bigQueryBytesBilled: string | null;
}
export interface Chart {
  id: string;
  title: string;
  kind: "line" | "bar";
  /** "date" when x holds YYYY-MM-DD days (gaps are null values), "label" for categories and horizons. */
  xKind: "date" | "label";
  unit: string;
  sentence: string;
  sentenceRefs: string[];
  evidenceAgainst: string | null;
  evidenceAgainstRefs: string[];
  x: string[];
  series: { name: string; values: (string | null)[] }[];
  datasetIds: string[];
  sqlExecuted: string;
  sqlBigQuery: string | null;
  bigQueryExecuted: boolean;
  queries: ChartQuery[];
  source: string;
  window: { from: string; to: string };
  caveats: string[];
  sha256: string;
}

const EST = "results/estimates.json";
const dayMs = 86_400_000;
const toMs = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const toDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

interface Pt {
  d: string;
  row: number;
  col: number;
  v: number;
}
const valueCols = (r: RawFile): number[] =>
  r.columns.map((c, i) => (i > 0 && c.type !== "date" && c.type !== "string" ? i : -1)).filter((i) => i > 0);

function points(r: RawFile, col: number): Pt[] {
  const out: Pt[] = [];
  r.rows.forEach((row, i) => {
    const v = row[col];
    if (v !== null && v !== undefined && Number.isFinite(Number(v)))
      out.push({ d: String(row[0]), row: i, col, v: Number(v) });
  });
  return out;
}
const ptr = (p: Pt): string => `/rows/${p.row}/${p.col}`;

function calendar(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = toMs(from); t <= toMs(to); t += dayMs) out.push(toDay(t));
  return out;
}
function spread(pts: Pt[], x: string[], raw: RawFile, col: number): (string | null)[] {
  const m = new Map(raw.rows.map((r) => [String(r[0]), r[col] ?? null]));
  return x.map((d) => (m.has(d) ? (m.get(d) as string | null) : null));
}

/** Deterministic one-sentence summary of a daily series: first, last, change in percent, peak with date. */
export function seriesSentence(L: Ledger, file: string, title: string, unit: string, pts: Pt[]): string {
  if (pts.length === 0) return `${title} has no observations in the frozen raw data.`;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const peak = pts.reduce((a, b) => (b.v > a.v ? b : a));
  const u = unit ? ` ${unit}` : "";
  const f = L.n(file, ptr(first));
  if (pts.length === 1) return `${title} has a single observation, ${f}${u} on ${first.d}.`;
  const l = L.n(file, ptr(last));
  const p = L.n(file, ptr(peak));
  const pct =
    first.v !== 0
      ? L.derived(file, "pct_change", [ptr(first), ptr(last)], fmtPct((last.v - first.v) / Math.abs(first.v)))
      : null;
  const change =
    pct !== null ? ` (${pct}% change)` : " (percent change is undefined because the first value is zero)";
  return `${title} went from ${f}${u} on ${first.d} to ${l}${u} on ${last.d}${change}, with a peak of ${p}${u} on ${peak.d}.`;
}

function declineNote(L: Ledger, file: string, title: string, pts: Pt[]): string | null {
  if (pts.length < 2) return null;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (!(last.v < first.v) || first.v === 0) return null;
  const pct = L.derived(
    file,
    "pct_change",
    [ptr(first), ptr(last)],
    fmtPct((last.v - first.v) / Math.abs(first.v)),
  );
  return `${title} ended below its first value (${pct}% change), so the window shows no sustained growth in this series.`;
}

/** Counts used by several notes, read from the frozen estimates. */
function comparisons(L: Ledger): { key: string; h: number; cand: string }[] {
  const e = L.get(EST, "/byHorizonCandidate") as Record<string, unknown>;
  return Object.keys(e)
    .map((k) => ({ key: k, h: Number(k.split(":")[0]), cand: k.split(":")[1]! }))
    .sort((a, b) => a.h - b.h || (a.cand < b.cand ? -1 : 1));
}
function forecastShortfall(L: Ledger): string {
  const all = comparisons(L);
  const worse = all.filter((c) => (L.get(EST, `/byHorizonCandidate/${c.key}/delta_mae`) as number) < 0);
  const k = L.count(EST, "/byHorizonCandidate", worse.length);
  const n = L.count(EST, "/byHorizonCandidate", all.length);
  return `${k} of ${n}`;
}
function intentsShortfall(L: Ledger): string {
  const h = L.get("results/hypothesis.json", "/primaryHorizon") as number;
  const key = `${h}:intents`;
  const hh = L.n("results/hypothesis.json", "/primaryHorizon");
  const c = L.n(EST, `/byHorizonCandidate/${key}/mae_candidate`);
  const b = L.n(EST, `/byHorizonCandidate/${key}/mae_baseline`);
  const p = L.n(EST, `/byHorizonCandidate/${key}/p_adjusted`);
  return `In the frozen forecast test, adding lagged Intents volume gave a higher out-of-sample error than the baseline at horizon ${hh}: MAE ${c} against ${b} (adjusted p-value ${p}), so a rising series is not evidence that it leads usage.`;
}

function datasetBits(inp: Inputs, ids: string[]) {
  const dss = ids
    .map((id) => inp.manifest.datasets.find((d) => d.id === id))
    .filter((d): d is ManifestDataset => !!d);
  const queries: ChartQuery[] = dss.map((d) => ({
    datasetId: d.id,
    sqlExecuted: d.sqlExecuted ? (inp.sql.get(d.sqlExecuted) ?? null) : null,
    sqlBigQuery: d.sqlBigQuery ? (inp.sql.get(d.sqlBigQuery) ?? null) : null,
    bigQueryExecuted: d.bigQueryExecuted,
    bigQueryBytesBilled: d.bigQueryBytesBilled,
  }));
  const withBq = queries.filter((q) => q.sqlBigQuery);
  const caveats = [
    ...new Set(
      dss.flatMap((d) => [
        ...d.caveats,
        ...(d.coverage.missingDays.length
          ? [`Days with no row in ${d.id}: ${d.coverage.missingDays.join(", ")} (not zero-filled).`]
          : []),
        ...(d.coverage.note ? [d.coverage.note] : []),
      ]),
    ),
  ];
  const hashes = dss.map((d) => d.sha256).filter((h): h is string => !!h);
  return {
    dss,
    queries,
    caveats,
    source: [...new Set(dss.map((d) => d.source))].join("; "),
    sqlExecuted: queries
      .map((q) =>
        q.sqlExecuted
          ? `-- dataset ${q.datasetId}\n${q.sqlExecuted.trimEnd()}`
          : `-- dataset ${q.datasetId}: no executed SQL recorded`,
      )
      .join("\n\n"),
    sqlBigQuery: withBq.length
      ? withBq.map((q) => `-- dataset ${q.datasetId}\n${q.sqlBigQuery!.trimEnd()}`).join("\n\n")
      : null,
    bigQueryExecuted: withBq.length > 0 && withBq.every((q) => q.bigQueryExecuted),
    sha256: hashes.length === 1 ? hashes[0]! : sha256Hex(hashes.join("\n")),
  };
}

function lineChart(
  inp: Inputs,
  L: Ledger,
  o: { id: string; datasetId: string; col: number; title: string; against: "intents" | "usage" | "none" },
): Chart | null {
  const ds = inp.manifest.datasets.find((d) => d.id === o.datasetId);
  if (!ds) return null;
  const r = inp.raw.get(o.datasetId);
  const bits = datasetBits(inp, [o.datasetId]);
  const file = `raw/${o.datasetId}.json`;
  const unit = ds.unit;
  const colName = r?.columns[o.col]?.name ?? "value";
  if (!r || r.rows.length === 0) {
    return {
      id: o.id,
      title: o.title,
      kind: "line",
      xKind: "date",
      unit,
      sentence: `Not computed: ${o.title} has no rows in the frozen raw data.`,
      sentenceRefs: [],
      evidenceAgainst: null,
      evidenceAgainstRefs: [],
      x: [],
      series: [],
      datasetIds: [o.datasetId],
      sqlExecuted: bits.sqlExecuted,
      sqlBigQuery: bits.sqlBigQuery,
      bigQueryExecuted: bits.bigQueryExecuted,
      queries: bits.queries,
      source: bits.source,
      window: { from: "", to: "" },
      caveats: bits.caveats,
      sha256: bits.sha256,
    };
  }
  const pts = points(r, o.col);
  const x = calendar(String(r.rows[0]![0]), String(r.rows[r.rows.length - 1]![0]));
  const s = L.collect(() => seriesSentence(L, file, o.title, unit, pts));
  const against = L.collect(() => {
    const parts: string[] = [];
    if (o.against === "intents") parts.push(intentsShortfall(L));
    if (o.against === "usage")
      parts.push(
        `The frozen forecast test predicted organic daily successful actions, not this series; in it ${forecastShortfall(L)} candidate comparisons had higher error than the baseline.`,
      );
    const d = declineNote(L, file, o.title, pts);
    if (d) parts.push(d);
    return parts.join(" ");
  });
  return {
    id: o.id,
    title: o.title,
    kind: "line",
    xKind: "date",
    unit,
    sentence: s.text,
    sentenceRefs: s.refs,
    evidenceAgainst: against.text || null,
    evidenceAgainstRefs: against.text ? against.refs : [],
    x,
    series: [{ name: colName, values: spread(pts, x, r, o.col) }],
    datasetIds: [o.datasetId],
    sqlExecuted: bits.sqlExecuted,
    sqlBigQuery: bits.sqlBigQuery,
    bigQueryExecuted: bits.bigQueryExecuted,
    queries: bits.queries,
    source: bits.source,
    window: { from: x[0]!, to: x[x.length - 1]! },
    caveats: bits.caveats,
    sha256: bits.sha256,
  };
}

function topChart(inp: Inputs, L: Ledger): Chart | null {
  const id = "contract_usage_top";
  const ds = inp.manifest.datasets.find((d) => d.id === id);
  if (!ds) return null;
  const r = inp.raw.get(id);
  const bits = datasetBits(inp, [id]);
  const base = {
    id: "top-contracts",
    title: "Top receiver contracts",
    kind: "bar" as const,
    xKind: "label" as const,
    unit: ds.unit,
    datasetIds: [id],
    sqlExecuted: bits.sqlExecuted,
    sqlBigQuery: bits.sqlBigQuery,
    bigQueryExecuted: bits.bigQueryExecuted,
    queries: bits.queries,
    source: bits.source,
    caveats: bits.caveats,
    sha256: bits.sha256,
  };
  const cols = r ? r.columns.map((c, i) => (i > 0 && c.type !== "string" ? i : -1)).filter((i) => i > 0) : [];
  if (!r || r.rows.length === 0 || cols.length === 0) {
    return {
      ...base,
      sentence: "Not computed: the top-contract table has no rows in the frozen raw data.",
      sentenceRefs: [],
      evidenceAgainst: null,
      evidenceAgainstRefs: [],
      x: [],
      series: [],
      window: { from: "", to: "" },
    };
  }
  const col = cols[0]!;
  const rows = r.rows.filter((row) => row[col] !== null && Number.isFinite(Number(row[col]))).slice(0, 15);
  const total = r.rows.reduce((a, row) => a + (Number.isFinite(Number(row[col])) ? Number(row[col]) : 0), 0);
  const top = r.rows.reduce((a, b, i) => (Number(b[col]) > Number(r.rows[a]![col]) ? i : a), 0);
  const file = `raw/${id}.json`;
  const topShare = total > 0 ? Number(r.rows[top]![col]) / total : null;
  const s = L.collect(() => {
    const v = L.n(file, `/rows/${top}/${col}`);
    const n = L.count(file, "/rows", r.rows.length);
    const share = topShare !== null ? L.derived(file, "share_of_listed", ["/rows"], fmtPct(topShare)) : null;
    const unit = ds.unit ? ` ${ds.unit}` : "";
    return `${String(r.rows[top]![0])} had the most traffic among the ${n} listed contracts, ${v}${unit}${share ? ` (${share}% of the listed total)` : ""}.`;
  });
  const against = L.collect(() => {
    if (topShare === null || topShare <= 0.5) return "";
    const share = L.derived(file, "share_of_listed", ["/rows"], fmtPct(topShare));
    return `One contract accounts for ${share}% of the listed total, so usage by contract is concentrated and a few contracts can dominate the daily counts.`;
  });
  return {
    ...base,
    sentence: s.text,
    sentenceRefs: s.refs,
    evidenceAgainst: against.text || null,
    evidenceAgainstRefs: against.text ? against.refs : [],
    x: rows.map((row) => String(row[0])),
    series: [{ name: r.columns[col]!.name, values: rows.map((row) => String(row[col])) }],
    window: { from: inp.manifest.window.from, to: inp.manifest.window.to },
  };
}

function indexChart(inp: Inputs, L: Ledger): Chart | null {
  const pid = "near_price_daily";
  const uid = "active_accounts_daily";
  const pr = inp.raw.get(pid);
  const ur = inp.raw.get(uid);
  const bits = datasetBits(inp, [pid, uid]);
  const base = {
    id: "price-vs-usage",
    title: "NEAR price and daily active accounts, indexed to 100",
    kind: "line" as const,
    xKind: "date" as const,
    unit: "index (first common day = 100)",
    datasetIds: [pid, uid],
    sqlExecuted: bits.sqlExecuted,
    sqlBigQuery: bits.sqlBigQuery,
    bigQueryExecuted: bits.bigQueryExecuted,
    queries: bits.queries,
    source: bits.source,
    caveats: bits.caveats,
    sha256: bits.sha256,
  };
  const empty = (why: string): Chart => ({
    ...base,
    sentence: why,
    sentenceRefs: [],
    evidenceAgainst: null,
    evidenceAgainstRefs: [],
    x: [],
    series: [],
    window: { from: "", to: "" },
  });
  if (!pr || !ur || pr.rows.length === 0 || ur.rows.length === 0)
    return empty("Not computed: the price or the active-account series has no rows in the frozen raw data.");
  const pc = valueCols(pr)[0] ?? 1;
  const uc = valueCols(ur)[0] ?? 1;
  const pp = new Map(points(pr, pc).map((p) => [p.d, p]));
  const up = new Map(points(ur, uc).map((p) => [p.d, p]));
  const common = [...pp.keys()].filter((d) => up.has(d)).sort();
  if (common.length < 2)
    return empty("Not computed: price and active accounts share fewer than two days with values.");
  const x = calendar(common[0]!, common[common.length - 1]!);
  const p0 = pp.get(common[0]!)!;
  const u0 = up.get(common[0]!)!;
  if (p0.v === 0 || u0.v === 0)
    return empty("Not computed: a series starts at zero, so it cannot be indexed to 100.");
  const idx = (m: Map<string, Pt>, p0v: number) =>
    x.map((d) => (m.has(d) ? ((m.get(d)!.v / p0v) * 100).toFixed(2) : null));
  const pl = pp.get(common[common.length - 1]!)!;
  const ul = up.get(common[common.length - 1]!)!;
  const pf = `raw/${pid}.json`;
  const uf = `raw/${uid}.json`;
  const s = L.collect(() => {
    const pi = L.derived(pf, "index_last", [ptr(p0), ptr(pl)], fmt((pl.v / p0.v) * 100));
    const ui = L.derived(uf, "index_last", [ptr(u0), ptr(ul)], fmt((ul.v / u0.v) * 100));
    const base = L.derived(pf, "index_base", [ptr(p0)], "100");
    return `Indexed to ${base} on ${common[0]}, NEAR price ended at ${pi} and daily active accounts at ${ui} on ${common[common.length - 1]}.`;
  });
  const against = L.collect(() => {
    const keys = Object.keys(L.get(EST, "/byHorizonCandidate") as object);
    const hs = [...new Set(keys.map((k) => Number(k.split(":")[0])))].sort((a, b) => a - b);
    const priceBetter = hs.filter(
      (h) =>
        (L.get(EST, `/byHorizonCandidate/${h}:price/mae_candidate`) as number) <
        (L.get(EST, `/byHorizonCandidate/${h}:intents/mae_candidate`) as number),
    );
    const k = L.count(EST, "/byHorizonCandidate", priceBetter.length);
    const n = L.count(EST, "/byHorizonCandidate", hs.length);
    return `In the frozen forecast test the model with price had lower error than the model with Intents volume at ${k} of ${n} horizons, and ${forecastShortfall(L)} candidate comparisons had higher error than the baseline; indexing is for display only and shows co-movement, not a lead.`;
  });
  return {
    ...base,
    sentence: s.text,
    sentenceRefs: s.refs,
    evidenceAgainst: against.text,
    evidenceAgainstRefs: against.refs,
    x,
    series: [
      { name: "NEAR price (index)", values: idx(pp, p0.v) },
      { name: "Daily active accounts (index)", values: idx(up, u0.v) },
    ],
    window: { from: x[0]!, to: x[x.length - 1]! },
  };
}

function forecastChart(inp: Inputs, L: Ledger): Chart {
  const keys = Object.keys(L.get(EST, "/byHorizonCandidate") as object);
  const hs = [...new Set(keys.map((k) => Number(k.split(":")[0])))].sort((a, b) => a - b);
  const num = (p: string): string => String(L.get(EST, p));
  const models: [string, string][] = [
    ["Baseline", "intents"],
    ["+ Intents", "intents"],
    ["+ price", "price"],
    ["+ both", "combined"],
  ];
  const series = models.map(([name, cand], i) => ({
    name,
    values: hs.map((h) =>
      num(`/byHorizonCandidate/${h}:${cand}/${i === 0 ? "mae_baseline" : "mae_candidate"}`),
    ),
  }));
  const lowest = hs.filter((h) => {
    const b = L.get(EST, `/byHorizonCandidate/${h}:intents/mae_baseline`) as number;
    return ["intents", "price", "combined"].every(
      (c) => b <= (L.get(EST, `/byHorizonCandidate/${h}:${c}/mae_candidate`) as number),
    );
  });
  const s = L.collect(() => {
    const k = L.count(EST, "/byHorizonCandidate", lowest.length);
    const n = L.count(EST, "/byHorizonCandidate", hs.length);
    const h = L.n("results/hypothesis.json", "/primaryHorizon");
    const b = L.n(EST, `/byHorizonCandidate/${h}:intents/mae_baseline`);
    const c = L.n(EST, `/byHorizonCandidate/${h}:intents/mae_candidate`);
    return `The baseline had the lowest out-of-sample error at ${k} of ${n} horizons; at horizon ${h} the error was ${b} for the baseline against ${c} with Intents added.`;
  });
  const against = L.collect(() => {
    const ps = keys.map((k) => L.get(EST, `/byHorizonCandidate/${k}/p_adjusted`) as number);
    const minKey = keys[ps.indexOf(Math.min(...ps))]!;
    const p = L.n(EST, `/byHorizonCandidate/${minKey}/p_adjusted`);
    const q = L.n("results/preregistration.json", "/fdr/q");
    return `${forecastShortfall(L)} candidate comparisons had higher error than the baseline, and the smallest adjusted p-value is ${p} against a threshold of ${q}.`;
  });
  const cmd = String(L.get("results/reproduction.json", "/command"));
  return {
    id: "forecast-comparison",
    title: "Out-of-sample forecast error by model and horizon",
    kind: "bar",
    xKind: "label",
    unit: "mean absolute error, log scale (lower is better); x is the horizon in days",
    sentence: s.text,
    sentenceRefs: s.refs,
    evidenceAgainst: against.text,
    evidenceAgainstRefs: against.refs,
    x: hs.map(String),
    series,
    datasetIds: [],
    sqlExecuted: `-- Not a SQL result: these errors come from the frozen research run (results/estimates.json).\n-- Command recorded by the run: ${cmd}`,
    sqlBigQuery: null,
    bigQueryExecuted: false,
    queries: [],
    source: "Frozen research run (live-organic-v3), results/estimates.json",
    window: {
      from: String(L.get("results/run_summary.json", "/window/start")),
      to: String(L.get("results/run_summary.json", "/window/end")),
    },
    caveats: ["The research window differs from the data-chart window; it is the window of the frozen run."],
    sha256: sha256Hex(JSON.stringify(inp.results.get("estimates.json"))),
  };
}

/** The eight required charts (contract usage yields one chart per value column). */
export function buildCharts(inp: Inputs, L: Ledger): Chart[] {
  const out: (Chart | null)[] = [
    lineChart(inp, L, {
      id: "intents-volume",
      datasetId: "intents_volume_daily",
      col: 1,
      title: "Intents volume",
      against: "intents",
    }),
    lineChart(inp, L, {
      id: "intents-swaps",
      datasetId: "intents_swaps_daily",
      col: 1,
      title: "Intents swap count",
      against: "intents",
    }),
    lineChart(inp, L, {
      id: "active-accounts",
      datasetId: "active_accounts_daily",
      col: 1,
      title: "Daily active accounts",
      against: "usage",
    }),
    lineChart(inp, L, {
      id: "transactions",
      datasetId: "transactions_daily",
      col: 1,
      title: "Daily transactions",
      against: "usage",
    }),
  ];
  const cu = inp.raw.get("contract_usage_daily");
  const cols = cu ? valueCols(cu) : [1];
  (cols.length ? cols : [1]).forEach((c, i) => {
    const name = cu?.columns[c]?.name ?? "value";
    out.push(
      lineChart(inp, L, {
        id: i === 0 ? "contract-usage" : `contract-usage-${name}`,
        datasetId: "contract_usage_daily",
        col: c,
        title: cols.length > 1 ? `Contract usage (${name.replace(/_/g, " ")})` : "Contract usage",
        against: "usage",
      }),
    );
  });
  out.push(topChart(inp, L), indexChart(inp, L), forecastChart(inp, L));
  return out.filter((c): c is Chart => c !== null);
}
