import { canonicalJson, sha256Hex } from "@nearesis/capsule";
import { Ledger, fmt, scanGrounding, scanSentence } from "./ground.ts";
import type { GroundViolation, Json } from "./ground.ts";
import { evaluateRule, ppmText, RULE, RULE_ID, RULE_TEXT } from "./rule.ts";
import type { RuleCode, VerdictStatus } from "./rule.ts";
import type { CapsuleFacts, FindingFact, PanelFile, PanelIndexEntry } from "./facts.ts";
import { SECTION_IDS, SECTION_TITLES, UNTESTED_NOTE, validateThesisDoc } from "./validate.ts";
import { renderThesisMarkdown } from "./render.ts";

/** Bumped when the generator's output for the same inputs changes. Part of the version hash. */
export const GENERATOR_VERSION = "user-thesis-1";

export interface HypothesisInput {
  id: string;
  status: "frozen" | "draft";
  proposition: string;
  falsification: string | null;
}
export interface MonitorBrief {
  ruleId: string;
  name: string;
  sourceId: string;
  enabled: boolean;
  action: string;
  markerId: string | null;
  metricIds: string[];
  watchesSeries: boolean;
}
export interface MarkerBrief {
  markerId: string;
  question: string | null;
  status: string;
  anchorType: string;
  timestamp: string;
  monitorRuleId: string | null;
}
export interface OutlayerState {
  status: string;
  requestId: string | null;
  txHash: string | null;
}
export interface PreviousThesis {
  version: string;
  verdict: string;
  n: number | null;
  pearson: string | null;
  lag: string | null;
}
export interface ThesisInputs {
  facts: CapsuleFacts;
  workspaceId: string;
  runId: string;
  question: string | null;
  /** ISO time the run last changed: the document's `generatedAt`. */
  frozenAt: string;
  /** When the capsule was last re-verified (shown in the verification block; not part of the version). */
  verifiedAt: string;
  capsuleStatus: "reproduced" | "mismatch";
  hypothesis: HypothesisInput | null;
  monitors: MonitorBrief[];
  markers: MarkerBrief[];
  outlayer: OutlayerState | null;
  previous: PreviousThesis | null;
}

export class ThesisBuildError extends Error {
  constructor(
    message: string,
    readonly detail: unknown = null,
  ) {
    super(message);
  }
}

const J = (x: unknown): Json => x as Json;
const sha = (s: string): string => sha256Hex(s);
const shortHash = (h: string): string => h.slice(0, 16);
const DAY = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0+)?Z)?$/;
const isDec = (c: unknown): boolean =>
  (typeof c === "number" && Number.isFinite(c)) ||
  (typeof c === "string" && /^-?\d+(\.\d+)?$/.test(c.trim()));
const cellText = (c: unknown): string => (typeof c === "number" ? String(c) : String(c).trim());
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const cell = (s: string): string => oneLine(s).replace(/\|/g, "\\|");

/** Version of the inputs of a thesis: the same inputs always give the same id. */
export function thesisVersionOf(i: ThesisInputs): string {
  return `v-${sha(
    canonicalJson({
      generator: GENERATOR_VERSION,
      rule: RULE_ID,
      capsuleId: i.facts.capsuleId,
      capsuleHash: i.facts.capsuleHash,
      runId: i.runId,
      capsuleStatus: i.capsuleStatus,
      hypothesis: i.hypothesis,
      monitors: i.monitors,
      markers: i.markers,
      outlayer: i.outlayer,
    }),
  ).slice(0, 12)}`;
}

// ---------------------------------------------------------------------------------------------------------------- coverage
export function coverageOf(
  p: PanelFile,
  window: { from: string; to: string },
): { complete: boolean | null; detail: string } {
  const rows = p.chart?.rows ?? [];
  const cols = p.chart?.columns ?? [];
  const dayCol = cols.findIndex((_, i) => rows.some((r) => DAY.test(String(r[i] ?? ""))));
  const days = dayCol >= 0 ? rows.map((r) => DAY.exec(String(r[dayCol] ?? ""))?.[1] ?? null) : [];
  const inWin = (d: string | null): boolean => d !== null && d >= window.from && d <= window.to;
  const rc = p.coverage?.rowCoverage;
  if (Array.isArray(rc) && rc.length === rows.length && dayCol >= 0) {
    const bad = rc.filter((c, i) => inWin(days[i] ?? null) && c !== "complete").length;
    return {
      complete: bad === 0,
      detail: bad === 0 ? "every day used is complete" : "some days used are not complete",
    };
  }
  if (p.coverage?.state) {
    const used = (list?: string[]): number =>
      (list ?? []).filter((d) => inWin(DAY.exec(d)?.[1] ?? null)).length;
    const bad = used(p.coverage.missingDays) + used(p.coverage.incompleteDays);
    const ok = p.coverage.state === "complete" && bad === 0;
    return {
      complete: ok,
      detail: ok ? "coverage state is complete" : `coverage state is ${p.coverage.state}`,
    };
  }
  return { complete: null, detail: "coverage is not stated" };
}

export const chartDataSha = (cd: Pick<ChartData, "x" | "series">): string =>
  sha(canonicalJson({ x: cd.x, series: cd.series.map((s) => ({ name: s.name, values: s.values })) }));

export interface ChartData {
  isDay: boolean;
  x: string[];
  series: Array<{ name: string; unit: string | null; values: Array<string | null>; ci: number }>;
}
/** The x axis and numeric series of a stored panel result (null when it has no table or no numeric column). Also used by verification. */
export function chartData(panel: PanelFile): ChartData | null {
  const cols = panel.chart?.columns ?? [];
  const rows = panel.chart?.rows ?? [];
  if (!rows.length || cols.length < 2) return null;
  const isDay = rows.every((r) => r[0] === null || DAY.test(String(r[0])));
  const x = rows.map((r) => (isDay ? (DAY.exec(String(r[0]))?.[1] ?? "") : String(r[0] ?? "")));
  const series: ChartData["series"] = [];
  cols.forEach((c, ci) => {
    if (ci === 0) return;
    const vals = rows.map((r) => r[ci]);
    if (vals.some((v) => v !== null && v !== undefined && !isDec(v)) || !vals.some((v) => isDec(v))) return;
    series.push({
      name: c.name,
      unit: c.unit ?? null,
      values: vals.map((v) => (v === null || v === undefined ? null : cellText(v))),
      ci,
    });
  });
  return series.length ? { isDay, x, series } : null;
}

// ------------------------------------------------------------------------------------------------------------------ charts
interface ChartBuild {
  chart: Record<string, unknown>;
  sentenceFn: () => string;
  /** indices into facts.index.panels */
  pi: number;
  primary: { ci: number; name: string };
}

const panelFileName = (hash: string): string => `panel-${shortHash(hash)}.json`;

function buildChart(
  facts: CapsuleFacts,
  L: Ledger,
  pe: PanelIndexEntry,
  pi: number,
): { build: ChartBuild | null; unable: string | null } {
  const panel = facts.panels.get(pe.hash)!;
  const file = panelFileName(pe.hash);
  const cols = panel.chart?.columns ?? [];
  const rows = panel.chart?.rows ?? [];
  if (!rows.length || cols.length < 2)
    return { build: null, unable: `${pe.title}: the stored result has no table with at least two columns` };
  const cd = chartData(panel);
  if (!cd) return { build: null, unable: `${pe.title}: the stored result has no numeric column` };
  const { isDay, x, series } = cd;
  const prim = series[0]!;
  const idx = prim.values.flatMap((v, i) => (v === null ? [] : [i]));
  const i0 = idx[0]!;
  const i1 = idx[idx.length - 1]!;
  let imax = i0;
  for (const i of idx) if (Number(prim.values[i]) > Number(prim.values[imax]!)) imax = i;
  const ptr = (i: number): string => `/chart/rows/${i}/${prim.ci}`;
  const xptr = (i: number): string => `/chart/rows/${i}/0`;
  const dayOf = (i: number): string =>
    isDay ? L.derived(file, "day", [xptr(i)], x[i]!) : L.s(file, xptr(i));
  const unitFn = (): string => (prim.unit ? ` ${L.s(file, `/chart/columns/${prim.ci}/unit`)}` : "");
  const sentenceFn = (): string => {
    const first = Number(prim.values[i0]);
    const last = Number(prim.values[i1]);
    const title = L.s("run-panels.json", `/panels/${pi}/title`);
    const name = L.s(file, `/chart/columns/${prim.ci}/name`);
    const label = title === name ? name : `${title} (${name})`;
    const pct =
      first !== 0 && i0 !== i1
        ? ` (${L.derived(file, "pct_change", [ptr(i0), ptr(i1)], `${fmt(((last - first) / Math.abs(first)) * 100)}%`)} change)`
        : "";
    return (
      `${label} went from ${L.n(file, ptr(i0))}${unitFn()} on ${dayOf(i0)} to ${L.n(file, ptr(i1))}${unitFn()} on ${dayOf(i1)}${pct}, ` +
      `with a peak of ${L.n(file, ptr(imax))}${unitFn()} on ${dayOf(imax)}.`
    );
  };
  const sent = L.collect(sentenceFn);

  // evidence against, only what the panel's own record says
  const against = L.collect(() => {
    const parts: string[] = [];
    const st = panel.state;
    if (typeof st === "string" && st !== "complete") {
      let t = `The panel's own coverage state is "${L.s(file, "/state")}"`;
      if (typeof panel.partialCount === "number" && typeof panel.nullCount === "number")
        t += ` with ${L.n(file, "/partialCount")} partial and ${L.n(file, "/nullCount")} missing values`;
      parts.push(`${t}, so some days may be incomplete.`);
    }
    const cert = panel.provenance?.certification;
    if (typeof cert === "string" && cert !== "certified")
      parts.push(
        `The result's certification is "${L.s(file, "/provenance/certification")}", not a fully certified metric.`,
      );
    if (Array.isArray(panel.gaps) && panel.gaps.length)
      parts.push(
        `The source reported ${L.count(file, "/gaps", panel.gaps.length)} gap(s) in this panel's data.`,
      );
    facts.findings.forEach((f, fi) => {
      if (
        (f.status === "mixed" || f.status === "insufficient") &&
        f.facts.some((x) => x.resultRef.queryHash === pe.hash)
      )
        parts.push(
          `A finding that cites this panel has the status ${L.s("findings.json", `/${fi}/status`)}; its skeptic notes are under Evidence against.`,
        );
    });
    return parts.join(" ");
  });
  const prov = panel.provenance ?? {};
  const queryBody = prov.ast ?? (prov as Record<string, unknown>).call ?? null;
  const sqlExecuted = [
    `-- executed query of panel ${pe.hash}`,
    `-- result sha256: ${typeof prov.resultHash === "string" ? prov.resultHash : "not stored"}`,
    `-- stored result file: ${pe.file} (sha256 ${pe.sha256})`,
    queryBody
      ? JSON.stringify(queryBody, null, 2)
      : "-- no executed query was stored with this panel's result",
  ].join("\n");
  const units = [...new Set(series.map((s) => s.unit).filter((u): u is string => !!u))];
  const dataSha = chartDataSha(cd);
  const chart = {
    id: `panel-${pe.hash.slice(0, 12)}`,
    title: pe.title,
    kind: isDay ? "line" : "bar",
    xKind: isDay ? "date" : "category",
    unit: units.length === 1 ? units[0]! : units.join(", ") || null,
    sentence: sent.text,
    sentenceRefs: sent.refs,
    evidenceAgainst: against.text || null,
    evidenceAgainstRefs: against.text ? against.refs : [],
    x,
    series: series.map((s) => ({ name: s.name, unit: s.unit, values: s.values })),
    datasetIds: [pe.hash],
    queryHash: pe.hash,
    resultHash: typeof prov.resultHash === "string" ? prov.resultHash : null,
    sqlExecuted,
    sqlBigQuery: null,
    bigQueryExecuted: false,
    queries: [
      {
        datasetId: pe.hash,
        sqlExecuted,
        sqlBigQuery: null,
        bigQueryExecuted: false,
        bigQueryBytesBilled: null,
      },
    ],
    source: pe.sourceLabel
      ? `${pe.sourceLabel}${pe.sources?.length ? `: ${pe.sources.join(", ")}` : ""}`
      : null,
    window: pe.window,
    caveats: pe.caveats,
    sha256: pe.sha256,
    dataSha256: dataSha,
    capsuleFile: `snapshot/${pe.file}`,
  };
  return { build: { chart, sentenceFn, pi, primary: { ci: prim.ci, name: prim.name } }, unable: null };
}

// -------------------------------------------------------------------------------------------------------------- the build
export interface ThesisDocument {
  schema: "nearesis.thesis.v1";
  version: string;
  generatedAt: string;
  hypothesis: string;
  verdict: {
    status: VerdictStatus;
    headline: string;
    comparison: {
      summary: string;
      rows: Array<{ label: string; value: string | null; unit: string | null; ref: string }>;
    };
    whatWouldChangeOurMind: string[];
  };
  sections: Array<{ id: string; title: string; markdown: string }>;
  claims: Array<Record<string, unknown>>;
  charts: Array<Record<string, unknown>>;
  tables: Array<{ name: string; system: string; purpose: string; columns: string[] }>;
  sampleQuery: { title: string; sql: string };
  unableToCompute: Array<{ what: string; why: string; refs: string[] }>;
  reproduce: Record<string, unknown>;
  files: Array<{ path: string; sha256: string; bytes?: number }>;
  grounding: { numbersChecked: number; references: number };
  origin: Record<string, unknown>;
  test: Record<string, unknown>;
  verification: Record<string, unknown>;
  monitors: MonitorBrief[];
  markers: MarkerBrief[];
}
export interface ThesisBuildOutput {
  doc: ThesisDocument;
  markdown: string;
  version: string;
  title: string;
  numbersChecked: number;
}

const FILE_LOCATION: Record<string, string> = {
  "results.json": "capsule computation/results.json (recomputed by the pinned verifier)",
  "run-panels.json": "capsule snapshot/raw/run-panels.json",
  "findings.json": "capsule snapshot/raw/run-findings.json",
};

export function buildThesis(inp: ThesisInputs): ThesisBuildOutput {
  const { facts } = inp;
  const sel = facts.index.selection;
  const version = thesisVersionOf(inp);
  const xPanel = facts.panels.get(sel.x.panelHash);
  const yPanel = facts.panels.get(sel.y.panelHash);
  if (!xPanel || !yPanel)
    throw new ThesisBuildError("the capsule index names a panel that is not in the capsule");

  const n = Number(facts.results.n);
  const pearsonPpm: bigint | null =
    facts.results.pearson_ppm == null ? null : BigInt(facts.results.pearson_ppm);
  const lagRaw = facts.results.lag_pearson_ppm?.[String(RULE.lagDays)];
  const lagPpm: bigint | null = lagRaw == null ? null : BigInt(lagRaw);
  const window = { from: facts.input.series.x.points[0]![0], to: facts.input.series.x.points.at(-1)![0] };
  const covX = coverageOf(xPanel, window);
  const covY = coverageOf(yPanel, window);
  const coverageComplete =
    covX.complete === null || covY.complete === null ? null : covX.complete && covY.complete;
  const rule = evaluateRule({ n, pearsonPpm, lagPpm, coverageComplete });
  const status = rule.status;

  // ledger files
  const files = new Map<string, Json>();
  files.set("results.json", J(facts.results));
  files.set("run-panels.json", J(facts.index));
  files.set("findings.json", J(facts.findings));
  files.set("rule.json", J(RULE));
  files.set("capsule.json", J({ id: facts.capsuleId, hash: facts.capsuleHash, label: facts.label }));
  files.set("hypothesis.json", J(inp.hypothesis ?? {}));
  files.set("monitors.json", J(inp.monitors));
  files.set("markers.json", J(inp.markers));
  files.set("previous.json", J(inp.previous ?? {}));
  for (const p of facts.index.panels) files.set(panelFileName(p.hash), J(facts.panels.get(p.hash)));
  const L = new Ledger(files);

  const R = "results.json";
  const xName = (): string => L.s("run-panels.json", "/selection/x/column");
  const yName = (): string => L.s("run-panels.json", "/selection/y/column");
  const nText = (): string => L.n(R, "/n");
  const fromTo = (): string =>
    `${L.derived(R, "window", ["/n"], window.from)} to ${L.derived(R, "window", ["/n"], window.to)}`;
  const rText = (): string => L.n(R, "/pearson_ppm", ppmText);
  const lagText = (): string => L.n(R, `/lag_pearson_ppm/${RULE.lagDays}`, ppmText);
  const ruleN = (k: keyof typeof RULE, show?: (x: number) => string): string =>
    L.n("rule.json", `/${k}`, show);
  const ruleP = (k: keyof typeof RULE): string => ruleN(k, ppmText);
  const claimText = inp.hypothesis?.proposition ?? null;
  const line = (fn: () => string): string => L.line(fn);

  // ---- charts
  const unable: Array<{ what: string; why: string; refs: string[] }> = [];
  const builds: ChartBuild[] = [];
  facts.index.panels.forEach((pe, pi) => {
    const r = buildChart(facts, L, pe, pi);
    if (r.build) builds.push(r.build);
    else if (r.unable) unable.push({ what: `Chart: ${r.unable.split(":")[0]}`, why: r.unable, refs: [] });
    if (r.build && !(r.build.chart.queries as unknown[]).length)
      unable.push({ what: "Executed query", why: "none stored", refs: [] });
  });
  for (const b of builds)
    if (String(b.chart.sqlExecuted).includes("no executed query was stored"))
      unable.push({
        what: `Executed query of ${String(b.chart.title)}`,
        why: "No executed query was stored with this panel's result, so the chart shows the stored result only.",
        refs: [],
      });

  // ---- findings split
  const fIdx = facts.findings.map((f, i) => ({ f, i }));
  const supported = fIdx.filter((x) => x.f.status === "supported");
  const notSupported = fIdx.filter((x) => x.f.status !== "supported");
  const quoteFinding = ({ f, i }: { f: FindingFact; i: number }): string[] => {
    const out: string[] = [];
    out.push(
      line(
        () =>
          `> Finding (${L.s("findings.json", `/${i}/status`)}${f.basis ? `, ${L.s("findings.json", `/${i}/basis`)}` : ""}): ${oneLine(L.s("findings.json", `/${i}/statement`))}`,
      ),
    );
    f.facts.forEach((fact, k) => {
      out.push(
        line(
          () =>
            `- Cited value: ${L.s("findings.json", `/${i}/facts/${k}/value`)}${fact.unit ? ` ${L.s("findings.json", `/${i}/facts/${k}/unit`)}` : ""} (${L.s("findings.json", `/${i}/facts/${k}/resultRef/column`)})`,
        ),
      );
    });
    return out;
  };

  // ---- evidence for / against lists (test numbers)
  const forTests: string[] = [];
  const againstTests: string[] = [];
  const againstFns: Array<() => string> = [];
  const addAgainst = (fn: () => string): void => {
    againstFns.push(fn);
    againstTests.push(line(() => `- ${fn()}`));
  };
  const addFor = (fn: () => string): void => void forTests.push(line(() => `- ${fn()}`));
  if (pearsonPpm !== null) {
    if (pearsonPpm >= BigInt(RULE.supportedSameDayPpm))
      addFor(
        () =>
          `The same-day Pearson correlation ${rText()} is at least the ${ruleP("supportedSameDayPpm")} the rule needs for support.`,
      );
    else
      addAgainst(
        () =>
          `The same-day Pearson correlation ${rText()} is below the ${ruleP("supportedSameDayPpm")} the rule needs for support.`,
      );
    if (pearsonPpm < BigInt(RULE.notSupportedBelowPpm))
      addAgainst(
        () =>
          `The same-day Pearson correlation ${rText()} is below the ${ruleP("notSupportedBelowPpm")} floor under which the rule gives NOT_SUPPORTED.`,
      );
  }
  if (lagPpm !== null) {
    if (lagPpm > 0n && lagPpm >= BigInt(RULE.supportedLagPpm))
      addFor(
        () =>
          `The ${ruleN("lagDays")}-day-lag correlation ${lagText()} is positive and at least ${ruleP("supportedLagPpm")}.`,
      );
    else
      addAgainst(
        () =>
          `The ${ruleN("lagDays")}-day-lag correlation ${lagText()} is not positive and at least ${ruleP("supportedLagPpm")}.`,
      );
  } else if (n >= RULE.supportedMinDays)
    addAgainst(
      () => `The ${ruleN("lagDays")}-day-lag correlation is not available for these ${nText()} days.`,
    );
  if (n >= RULE.supportedMinDays)
    addFor(
      () =>
        `The series share ${nText()} aligned days, at least the ${ruleN("supportedMinDays")} the rule needs for support.`,
    );
  else
    addAgainst(
      () =>
        `The series share ${nText()} aligned days, fewer than the ${ruleN("supportedMinDays")} the rule needs for support.`,
    );
  if (coverageComplete !== true)
    addAgainst(
      () =>
        `The coverage of the days used is ${coverageComplete === null ? "not stated" : "not complete"} for at least one of the two panels (${xName()}: ${covX.detail}; ${yName()}: ${covY.detail}).`,
    );

  // skeptic notes (all, deduplicated, verbatim) and limitations
  const noteLines: string[] = [];
  const seenNotes = new Set<string>();
  fIdx.forEach(({ f, i }) =>
    f.skepticNotes.forEach((s, k) => {
      if (seenNotes.has(s)) return;
      seenNotes.add(s);
      noteLines.push(
        line(() => `> Skeptic note: ${oneLine(L.s("findings.json", `/${i}/skepticNotes/${k}`))}`),
      );
    }),
  );
  const limLines: string[] = [];
  const seenLim = new Set<string>();
  fIdx.forEach(({ f, i }) =>
    f.limitations.forEach((s, k) => {
      if (seenLim.has(s)) return;
      seenLim.add(s);
      limLines.push(
        line(
          () =>
            `> Limitation recorded with a finding: ${oneLine(L.s("findings.json", `/${i}/limitations/${k}`))}`,
        ),
      );
    }),
  );

  // ---- monitors/markers
  const watching = inp.monitors.map((m, i) => ({ m, i })).filter((x) => x.m.watchesSeries);

  // ---- comparison rows
  const rows: ThesisDocument["verdict"]["comparison"]["rows"] = [];
  const addRow = (label: string, value: string | null, unit: string | null, ref: string): void => {
    rows.push({ label, value, unit, ref });
  };
  addRow("Aligned daily points", String(n), "days", `${R}#/n`);
  addRow(
    "Same-day Pearson correlation",
    pearsonPpm === null ? null : ppmText(pearsonPpm),
    "ratio",
    `${R}#/pearson_ppm`,
  );
  addRow(
    `Pearson correlation at a lag of ${RULE.lagDays} days`,
    lagPpm === null ? null : ppmText(lagPpm),
    "ratio",
    `${R}#/lag_pearson_ppm/${RULE.lagDays}`,
  );
  const growth = (k: "x" | "y"): string | null => {
    const g = facts.results[k]?.growth_bps;
    return g == null ? null : (Number(g) / 100).toFixed(2);
  };
  addRow(`${sel.x.column}: change, first to last day`, growth("x"), "percent", `${R}#/x/growth_bps`);
  addRow(`${sel.y.column}: change, first to last day`, growth("y"), "percent", `${R}#/y/growth_bps`);

  // ---- headline + summary
  const reasonSentence = (c: RuleCode): string => {
    switch (c) {
      case "N_BELOW_MIN":
        return `there are ${nText()} aligned days, fewer than the ${ruleN("minDays")} the rule needs`;
      case "COVERAGE_NOT_COMPLETE":
        return `the coverage of the days used is ${coverageComplete === null ? "not stated" : "not complete"} for at least one of the two panels`;
      case "CORRELATION_UNDEFINED":
        return "the correlation is undefined for these series";
      default:
        return "";
    }
  };
  const headlineFn = (): string => {
    const names = `${xName()} and ${yName()}`;
    if (status === "INSUFFICIENT_DATA")
      return `INSUFFICIENT_DATA: the stored data do not let the relationship rule judge ${names}: ${rule.codes.map(reasonSentence).filter(Boolean).join("; ")}.`;
    return `${status}: for ${names} over ${nText()} aligned days (${fromTo()}) the same-day Pearson correlation is ${rText()}; this is a descriptive rule, not a significance test, and it does not show cause.`;
  };
  const head = L.collect(headlineFn);
  const summaryFn = (): string =>
    pearsonPpm === null
      ? `No correlation could be computed for ${xName()} and ${yName()}.`
      : `${xName()} and ${yName()} share ${nText()} aligned days; the same-day correlation is ${rText()}${lagPpm !== null ? ` and the ${ruleN("lagDays")}-day-lag correlation is ${lagText()}` : ""}.`;
  const summary = L.collect(summaryFn);

  // ---- what would change our mind
  const changeMind: string[] = [];
  if (inp.hypothesis?.falsification)
    changeMind.push(
      line(
        () =>
          `- The author's falsification criterion (${L.s("hypothesis.json", "/status")} hypothesis): ${oneLine(L.s("hypothesis.json", "/falsification"))}`,
      ),
    );
  else
    changeMind.push(
      "- No falsification criterion was recorded for the hypothesis, so only the rule's thresholds below can change the verdict.",
    );
  changeMind.push(
    line(
      () =>
        `- A same-day Pearson correlation below ${ruleP("notSupportedBelowPpm")} over at least ${ruleN("minDays")} complete aligned days would give NOT_SUPPORTED.`,
    ),
  );
  changeMind.push(
    line(
      () =>
        `- A same-day correlation of at least ${ruleP("supportedSameDayPpm")} with a ${ruleN("lagDays")}-day-lag correlation of at least ${ruleP("supportedLagPpm")} over at least ${ruleN("supportedMinDays")} complete aligned days would give SUPPORTED.`,
    ),
  );
  changeMind.push(
    line(
      () =>
        `- Fewer than ${ruleN("minDays")} aligned days, or incomplete coverage of the days used, gives INSUFFICIENT_DATA whatever the correlation is.`,
    ),
  );
  for (const { m, i } of watching)
    changeMind.push(
      line(
        () =>
          `- Monitor rule "${L.s("monitors.json", `/${i}/name`)}" watches this series on source ${L.s("monitors.json", `/${i}/sourceId`)} (${m.enabled ? "enabled" : "disabled"}); a trigger is a reason to rebuild this thesis.`,
      ),
    );

  // ---- sections
  const sec = new Map<string, string>();
  const claimLine = (): string =>
    claimText !== null
      ? `> Claim (${L.s("hypothesis.json", "/status")} hypothesis): ${oneLine(L.s("hypothesis.json", "/proposition"))}`
      : `Claim (default wording, no hypothesis was recorded for this workspace): ${xName()} and ${yName()} move together over the window.`;
  const VERDICT_TEXT: Record<VerdictStatus, string> = {
    SUPPORTED: "the series moved together over the window under the relationship-v1 rule",
    MIXED: "the series moved together only partly; not every threshold for support was met",
    NOT_SUPPORTED:
      "the same-day correlation is below the level at which the rule treats the series as related",
    INSUFFICIENT_DATA: "the stored data do not let the rule give a verdict",
  };
  sec.set(
    "executive-claim",
    [
      `Verdict **${status}**: ${VERDICT_TEXT[status]}.`,
      line(claimLine),
      line(summaryFn),
      status === "INSUFFICIENT_DATA"
        ? line(() => `Reason: ${rule.codes.map(reasonSentence).filter(Boolean).join("; ")}.`)
        : "",
      "Evidence against has its own section with every skeptic note. This is a descriptive correlation rule, not a significance test, and a correlation does not show cause.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  sec.set("what-would-change-our-mind", changeMind.join("\n"));
  const panelRows = facts.index.panels.map((p, pi) =>
    line(
      () =>
        `| ${cell(L.s("run-panels.json", `/panels/${pi}/title`))} | ${cell(p.sourceLabel ? L.s("run-panels.json", `/panels/${pi}/sourceLabel`) : "not stated")}${p.sources?.length ? cell(`: ${p.sources.map((_, k) => L.s("run-panels.json", `/panels/${pi}/sources/${k}`)).join(", ")}`) : ""} | ${p.window ? `${L.s("run-panels.json", `/panels/${pi}/window/from`)} to ${L.s("run-panels.json", `/panels/${pi}/window/to`)}` : "not stated"} | ${p.state ? L.s("run-panels.json", `/panels/${pi}/state`) : "not stated"} | ${p.metricVersion ? cell(L.s("run-panels.json", `/panels/${pi}/metricVersion`)) : "not stated"} |`,
    ),
  );
  sec.set(
    "sample-and-sources",
    [
      line(
        () =>
          `The run produced ${L.count("run-panels.json", "/panels", facts.index.panels.length)} result panel(s); the test uses ${xName()} and ${yName()} over ${nText()} aligned days (${fromTo()}). Run source: ${L.s("run-panels.json", "/runSource")}.`,
      ),
      "| Panel | Source | Window | State | Metric version |\n|---|---|---|---|---|",
      ...panelRows,
    ].join("\n"),
  );
  sec.set(
    "methods",
    [
      line(
        () =>
          `The test is ${RULE_ID}, a descriptive correlation rule with constants fixed before any run: at least ${ruleN("minDays")} aligned days for any verdict, at least ${ruleN("supportedMinDays")} for SUPPORTED, same-day correlation at least ${ruleP("supportedSameDayPpm")} and ${ruleN("lagDays")}-day-lag correlation at least ${ruleP("supportedLagPpm")} for SUPPORTED, and same-day correlation below ${ruleP("notSupportedBelowPpm")} for NOT_SUPPORTED.`,
      ),
      line(
        () =>
          `Series choice (capsule rule, version ${L.n("run-panels.json", "/selection/ruleVersion")}): ${L.s("run-panels.json", "/selection/rule")} Here ${L.count("run-panels.json", "/selection/candidates", sel.candidates.length)} candidate series were found and the chosen pair shares ${L.n("run-panels.json", "/selection/overlapDays")} consecutive days${sel.truncatedToLatest ? ", of which the latest are kept" : ""}.`,
      ),
      "The correlations are exact integers in parts per million computed by the capsule's pinned verifier from the two aligned series; the percent changes are first to last day. This is a descriptive correlation rule, not a significance test, and no interval is computed.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  sec.set(
    "primary-benchmark",
    [
      "| Quantity | Value | Unit |\n|---|---|---|",
      line(() => `| Aligned daily points | ${nText()} | days |`),
      pearsonPpm === null
        ? "| Same-day Pearson correlation | not computable | ratio |"
        : line(() => `| Same-day Pearson correlation | ${rText()} | ratio |`),
      lagPpm === null
        ? `| Pearson correlation at a lag of ${RULE.lagDays} days | not computable | ratio |`
        : line(() => `| Pearson correlation at a lag of ${ruleN("lagDays")} days | ${lagText()} | ratio |`),
      ...(["x", "y"] as const).map((k) =>
        facts.results[k]?.growth_bps == null
          ? `| ${cell(sel[k].column)} change, first to last day | not computable | percent |`
          : line(
              () =>
                `| ${cell(k === "x" ? xName() : yName())} change, first to last day | ${L.n(R, `/${k}/growth_bps`, (b) => (b / 100).toFixed(2))} | percent |`,
            ),
      ),
    ].join("\n"),
  );
  sec.set(
    "evidence-for",
    [
      ...forTests,
      ...supported.flatMap(quoteFinding),
      ...(forTests.length || supported.length
        ? []
        : ["No finding of the run and no test number favours the claim."]),
    ].join("\n"),
  );
  const againstBody = [...againstTests, ...notSupported.flatMap(quoteFinding), ...noteLines, ...limLines];
  const untested = againstBody.length === 0;
  sec.set("evidence-against", untested ? `${UNTESTED_NOTE}.` : againstBody.join("\n"));
  if (untested)
    unable.push({
      what: "Evidence against",
      why: `${UNTESTED_NOTE}: neither a test number, a finding, a skeptic note nor a limitation cuts against the claim.`,
      refs: [],
    });
  const certs = facts.index.panels.flatMap((p, pi) => {
    const c = facts.panels.get(p.hash)?.provenance?.certification;
    return typeof c === "string" && c !== "certified" ? [{ pi, hash: p.hash }] : [];
  });
  const gapped = facts.index.panels.flatMap((p, pi) =>
    (facts.panels.get(p.hash)?.gaps?.length ?? 0) > 0
      ? [{ pi, hash: p.hash, n: facts.panels.get(p.hash)!.gaps!.length }]
      : [],
  );
  sec.set(
    "confounders-and-blind-spots",
    [
      "- A correlation does not show cause: a third quantity, a shared calendar pattern or a trend in both series can produce the same number.",
      line(
        () =>
          `- The pair was chosen by rule among ${L.count("run-panels.json", "/selection/candidates", sel.candidates.length)} candidate series, not named in advance, so a correlation of this size can arise by chance among the many pairs the rule could pick.`,
      ),
      "- Daily totals hide within-day timing, and the window was chosen by the run, not by the thesis.",
      ...certs.map(({ pi, hash }) =>
        line(
          () =>
            `- Panel "${L.s("run-panels.json", `/panels/${pi}/title`)}" has the certification "${L.s(panelFileName(hash), "/provenance/certification")}", not a fully certified metric.`,
        ),
      ),
      ...gapped.map(({ pi, hash, n: g }) =>
        line(
          () =>
            `- Panel "${L.s("run-panels.json", `/panels/${pi}/title`)}" reports ${L.count(panelFileName(hash), "/gaps", g)} source gap(s) in its data.`,
        ),
      ),
      ...facts.index.panels.flatMap((p, pi) =>
        p.caveats.map((_, k) =>
          line(
            () =>
              `- Caveat of panel "${L.s("run-panels.json", `/panels/${pi}/title`)}": ${oneLine(L.s("run-panels.json", `/panels/${pi}/caveats/${k}`))}`,
          ),
        ),
      ),
    ].join("\n"),
  );
  sec.set(
    "long-term-economic-mechanisms",
    claimText !== null
      ? [
          "Interpretation, not a result of this test and carrying no numbers of its own:",
          line(() => `> ${oneLine(L.s("hypothesis.json", "/proposition"))}`),
        ].join("\n\n")
      : "No mechanism was stated for this workspace, and this thesis makes none.",
  );

  // ---- claims
  const claims: Array<Record<string, unknown>> = [];
  const claimRows: string[] = [];
  const pushClaim = (
    c: Record<string, string | null>,
    fill: () => Record<string, string | null>,
    kind: string,
    id: string,
  ): void => {
    void c;
    const col = L.collect(() => {
      const v = fill();
      claims.push({ id, kind, ...v, refs: [] });
      return "";
    });
    const last = claims[claims.length - 1]!;
    last.refs = col.refs;
    claimRows.push(
      `| ${["statement", "verdict", "estimate", "uncertainty", "counterexample", "falsification", "provenance"].map((k) => cell(String(last[k] ?? ""))).join(" | ")} | ${col.refs.map((r) => `[${r}]`).join("")} |`,
    );
  };
  pushClaim(
    {},
    () => ({
      statement:
        claimText !== null
          ? oneLine(L.s("hypothesis.json", "/proposition"))
          : `${xName()} and ${yName()} move together over the window.`,
      verdict: status,
      estimate:
        pearsonPpm === null
          ? "The same-day correlation could not be computed"
          : `Same-day Pearson correlation ${rText()} over ${nText()} aligned days (${fromTo()})`,
      uncertainty: "None computed: the relationship rule is descriptive and gives no interval",
      counterexample: againstFns.length ? againstFns[0]!() : "None recorded",
      falsification: inp.hypothesis?.falsification
        ? oneLine(L.s("hypothesis.json", "/falsification"))
        : `NOT_SUPPORTED if the same-day correlation is below ${ruleP("notSupportedBelowPpm")} over at least ${ruleN("minDays")} complete aligned days`,
      provenance: `capsule ${facts.capsuleId} (hash ${facts.capsuleHash}); rule ${RULE_ID}`,
    }),
    "hypothesis",
    "claim-hypothesis",
  );
  for (const b of builds)
    pushClaim(
      {},
      () => ({
        statement: `Observed: ${L.s("run-panels.json", `/panels/${b.pi}/title`)}`,
        verdict: "OBSERVED",
        estimate: b.sentenceFn(),
        uncertainty: "Exact values from the stored result; no estimate",
        counterexample: (() => {
          L.reuse(b.chart.evidenceAgainstRefs as string[]);
          return (b.chart.evidenceAgainst as string | null) ?? "None recorded";
        })(),
        falsification:
          "Contradicted if the stored result, re-read from the capsule, differs from the values shown",
        provenance: `panel ${String(b.chart.queryHash)}; result sha256 ${String(b.chart.resultHash ?? "not stored")}`,
      }),
      "observed fact",
      `claim-observed-${String(b.chart.id)}`,
    );
  fIdx.forEach(({ f, i }) =>
    pushClaim(
      {},
      () => ({
        statement: L.s("findings.json", `/${i}/statement`),
        verdict: f.status.toUpperCase(),
        estimate:
          f.facts
            .map(
              (_, k) =>
                `${L.s("findings.json", `/${i}/facts/${k}/value`)}${f.facts[k]!.unit ? ` ${L.s("findings.json", `/${i}/facts/${k}/unit`)}` : ""}`,
            )
            .join("; ") || "No cited value",
        uncertainty: "Not quantified",
        counterexample: f.skepticNotes[0] ? L.s("findings.json", `/${i}/skepticNotes/0`) : "None recorded",
        falsification: "Contradicted if the cited result cells differ when re-read from the capsule",
        provenance: `findings of the run, capsule ${facts.capsuleId}`,
      }),
      f.basis === "observation" ? "observed fact" : "derived statistic",
      `claim-finding-${i + 1}`,
    ),
  );
  if (claimText !== null)
    pushClaim(
      {},
      () => ({
        statement: "Mechanisms behind the hypothesis (section Long-term economic mechanisms)",
        verdict: "NOT TESTED",
        estimate: "None; an interpretation carries no numbers",
        uncertainty: "Not quantified",
        counterexample: "None recorded",
        falsification: "Not applicable: not tested here",
        provenance: "hypothesis text of the workspace",
      }),
      "interpretation",
      "claim-mechanisms",
    );
  sec.set(
    "verdict-per-claim",
    [
      "| Claim | verdict | estimate | uncertainty | counterexample | falsificationCondition | provenance | refs |\n|---|---|---|---|---|---|---|---|",
      ...claimRows,
    ].join("\n"),
  );
  // claims in the document carry `falsification` as the reference does; the table header keeps the reference's name

  // ---- unable to compute
  unable.unshift(
    {
      what: "Causal effect of one series on the other",
      why: "Excluded by design: the relationship-v1 rule is descriptive and a correlation does not show cause.",
      refs: [],
    },
    {
      what: "Significance test or interval for the correlation",
      why: "The relationship-v1 rule computes none, so the document makes no significance claim.",
      refs: [],
    },
    {
      what: "Any lag other than the one the rule fixes, any non-linear relation, any out-of-sample forecast",
      why: "Only the same-day and one fixed-lag Pearson correlations are computed from the capsule's series.",
      refs: [],
    },
  );
  if (lagPpm === null)
    unable.push({
      what: `Correlation at a lag of ${RULE.lagDays} days`,
      why: "Not available in the capsule's results for these series.",
      refs: [`${R}#/lag_pearson_ppm`],
    });
  if (pearsonPpm === null)
    unable.push({
      what: "Same-day correlation",
      why: "Undefined for these series (a series is constant).",
      refs: [`${R}#/n`],
    });
  if (!inp.hypothesis)
    unable.push({
      what: "Author's hypothesis and falsification criterion",
      why: "The workspace has no hypothesis record, so the claim is the default wording and no author criterion exists.",
      refs: [],
    });
  else if (!inp.hypothesis.falsification)
    unable.push({
      what: "Author's falsification criterion",
      why: "The hypothesis has no falsification text.",
      refs: [],
    });
  if (!inp.outlayer)
    unable.push({
      what: "OutLayer attestation",
      why: "No OutLayer proof is recorded for this capsule; only the local recomputation is available.",
      refs: [],
    });
  for (const s of facts.index.selection.skippedPanels)
    unable.push({ what: "Panel not usable as a series", why: s, refs: [] });
  sec.set("unable-to-compute", unable.map((u) => `- **${oneLine(u.what)}**: ${oneLine(u.why)}`).join("\n"));

  // ---- reproduction + source index
  const capsuleHashes = [...facts.fileHashes]
    .map(([path, sha256]) => ({ path, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  sec.set(
    "reproduction",
    [
      `The thesis is a deterministic function of the capsule ${facts.capsuleId} (hash ${facts.capsuleHash}), the hypothesis record and the monitor and marker records listed in it; no model is called to build it.`,
      "- Verify: press Verify on the thesis page (or POST /v1/theses/{thesisId}/verify). It is free and runs no model and no chain call. It checks the document hash, every chart's data against the capsule's stored panel results, the capsule itself (raw hashes, recomputed metrics, WASM cross-check when available), the test numbers recomputed from the frozen series, and the OutLayer proof state when one exists.",
      "- Reproduce: press Reproduce to plan the same question in your own account; the run uses your credits and ends with a comparison of the two theses.",
      "- Data: the aligned series and the recomputed results are served beside the document (data/daily_series.csv, data/verifier-input.json, data/results.json).",
    ].join("\n"),
  );
  const locOf = (name: string): { loc: string; h: string } => {
    if (name === "rule.json")
      return { loc: "constants of this document (rule relationship-v1)", h: sha(canonicalJson(RULE)) };
    if (FILE_LOCATION[name]) {
      const rel =
        name === "results.json"
          ? "computation/results.json"
          : name === "run-panels.json"
            ? "snapshot/raw/run-panels.json"
            : "snapshot/raw/run-findings.json";
      return {
        loc: FILE_LOCATION[name]!,
        h: facts.fileHashes.get(rel) ?? sha(canonicalJson(files.get(name)!)),
      };
    }
    const p = facts.index.panels.find((q) => panelFileName(q.hash) === name);
    if (p) return { loc: `capsule snapshot/${p.file}`, h: p.sha256 };
    return { loc: "workspace record at build time", h: sha(canonicalJson(files.get(name)!)) };
  };
  sec.set(
    "source-index",
    [
      "Citations in square brackets are `file#pointer` into the files below, which are part of the capsule or are recorded in the document.",
      "| Cited as | Location | sha256 |\n|---|---|---|",
      ...[...files.keys()].map((k) => `| ${k} | ${locOf(k).loc} | ${locOf(k).h} |`),
    ].join("\n"),
  );
  sec.set(
    "changes-since-previous-version",
    inp.previous
      ? [
          line(
            () =>
              `Previous version of this workspace's thesis: ${L.s("previous.json", "/version")}, verdict ${L.s("previous.json", "/verdict")}${inp.previous!.n !== null ? `, ${L.n("previous.json", "/n")} aligned days` : ""}${inp.previous!.pearson !== null ? `, same-day correlation ${L.s("previous.json", "/pearson")}` : ""}.`,
          ),
          line(
            () =>
              `This version: ${status}, ${nText()} aligned days${pearsonPpm !== null ? `, same-day correlation ${rText()}` : ""}.`,
          ),
        ].join("\n")
      : `First version of this workspace's thesis, id ${version}. The version id is derived from the hashes of its inputs, so any change in the capsule, the hypothesis, the monitors or the markers changes it.`,
  );

  // ---- scan
  const violations: GroundViolation[] = [];
  let checked = 0;
  const take = (r: { violations: GroundViolation[]; numbersChecked: number }, where: string): void => {
    checked += r.numbersChecked;
    for (const v of r.violations) violations.push({ ...v, text: `${where}: ${v.text}` });
  };
  for (const id of SECTION_IDS) take(scanGrounding(sec.get(id) ?? "", L), id);
  for (const b of builds) {
    const c = b.chart as {
      id: string;
      sentence: string;
      sentenceRefs: string[];
      evidenceAgainst: string | null;
      evidenceAgainstRefs: string[];
    };
    take(scanSentence(c.sentence, c.sentenceRefs, L), `chart ${c.id} sentence`);
    if (c.evidenceAgainst)
      take(scanSentence(c.evidenceAgainst, c.evidenceAgainstRefs, L), `chart ${c.id} evidenceAgainst`);
  }
  take(scanSentence(head.text, head.refs, L), "headline");
  take(scanSentence(summary.text, summary.refs, L), "summary");
  changeMind.forEach((w, i) => take(scanGrounding(w, L), `whatWouldChangeOurMind ${i}`));
  if (violations.length)
    throw new ThesisBuildError(`ungrounded numbers: ${violations.length}`, violations.slice(0, 20));

  // ---- the document
  const sections = SECTION_IDS.map((id, i) => ({
    id,
    title: SECTION_TITLES[i]!,
    markdown: sec.get(id)!.trim(),
  }));
  const claim = claimText ?? `${sel.x.column} and ${sel.y.column} move together over the window`;
  const outlayerBlock = inp.outlayer
    ? { status: inp.outlayer.status, requestId: inp.outlayer.requestId, txHash: inp.outlayer.txHash }
    : null;
  const doc: ThesisDocument = {
    schema: "nearesis.thesis.v1",
    version,
    generatedAt: inp.frozenAt,
    hypothesis: claim,
    verdict: {
      status,
      headline: head.text,
      comparison: { summary: summary.text, rows },
      whatWouldChangeOurMind: changeMind.map((w) => w.replace(/^- /, "")),
    },
    sections,
    claims,
    charts: builds.map((b) => b.chart),
    tables: facts.index.panels.map((p) => ({
      name: p.hash,
      system: p.sourceLabel ?? "stored result",
      purpose: p.title,
      columns: (facts.panels.get(p.hash)?.chart?.columns ?? []).map((c) => c.name),
    })),
    sampleQuery: (() => {
      const b = builds[0];
      return b
        ? { title: `Executed query of ${String(b.chart.title)}`, sql: String(b.chart.sqlExecuted) }
        : { title: "No executed query available", sql: "-- none" };
    })(),
    unableToCompute: unable,
    reproduce: {
      kind: "capsule",
      command: "POST /v1/theses/{thesisId}/verify",
      check: "capsule re-verification: raw hashes, recomputed metrics, WASM cross-check when available",
      capsuleId: facts.capsuleId,
      capsuleHash: facts.capsuleHash,
      hashes: capsuleHashes,
    },
    files: [],
    grounding: { numbersChecked: checked, references: L.entries.size },
    origin: {
      kind: "workspace",
      workspaceId: inp.workspaceId,
      runId: inp.runId,
      capsuleId: facts.capsuleId,
      capsuleHash: facts.capsuleHash,
      hypothesisId: inp.hypothesis?.id ?? null,
      hypothesisStatus: inp.hypothesis?.status ?? null,
      question: inp.question,
    },
    test: {
      rule: RULE_ID,
      ruleText: RULE_TEXT,
      x: { name: sel.x.column, unit: sel.x.unit, panelHash: sel.x.panelHash },
      y: { name: sel.y.column, unit: sel.y.unit, panelHash: sel.y.panelHash },
      n,
      window,
      pearson: pearsonPpm === null ? null : ppmText(pearsonPpm),
      pearsonPpm: pearsonPpm === null ? null : pearsonPpm.toString(),
      lag: [{ days: RULE.lagDays, value: lagPpm === null ? null : ppmText(lagPpm) }],
      coverage: { x: covX, y: covY, complete: coverageComplete },
      reasons: rule.codes,
      thresholds: {
        ...RULE,
        supportedSameDay: ppmText(RULE.supportedSameDayPpm),
        supportedLag: ppmText(RULE.supportedLagPpm),
        notSupportedBelow: ppmText(RULE.notSupportedBelowPpm),
      },
    },
    verification: {
      capsule: { status: inp.capsuleStatus, checkedAt: inp.verifiedAt },
      outlayer: outlayerBlock,
    },
    monitors: inp.monitors,
    markers: inp.markers,
  };
  // wording and structure
  const valid = validateThesisDoc(doc);
  if (!valid.ok)
    throw new ThesisBuildError("the thesis failed wording or structure validation", valid.failures);
  const markdown = renderThesisMarkdown({ title: claim.slice(0, 300), doc });
  const mdBytes = Buffer.byteLength(markdown);
  const dataFile = (path: string, rel: string): { path: string; sha256: string } | null => {
    const h = facts.fileHashes.get(rel);
    return h ? { path, sha256: h } : null;
  };
  doc.files = [
    { path: "THESIS.md", sha256: sha(markdown), bytes: mdBytes },
    dataFile("data/daily_series.csv", "snapshot/raw/daily_series.csv"),
    dataFile("data/verifier-input.json", "computation/verifier-input.json"),
    dataFile("data/results.json", "computation/results.json"),
  ].filter((f): f is { path: string; sha256: string; bytes?: number } => f !== null);
  return { doc, markdown, version, title: claim.slice(0, 300), numbersChecked: checked };
}
