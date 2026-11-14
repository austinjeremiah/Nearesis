import { canonicalJson, concept, sha256Hex } from "@nearesis/capsule";
import type { Relatedness, TestPlan } from "@nearesis/capsule";
import { Ledger, fmt, scanGrounding, scanSentence } from "./ground.ts";
import type { GroundViolation, Json } from "./ground.ts";
import { evaluateRuleV2, falsificationOf, ppmText, RULE_V2, RULE_V2_ID, RULE_V2_TEXT } from "./rule.ts";
import type { RuleCode, VerdictStatus } from "./rule.ts";
import { BOOTSTRAP } from "./stats.ts";
import { GROUP_TITLE, NOTE_GROUPS, groupNotes, relationOfFindings } from "./evidence.ts";
import type { NoteItem } from "./evidence.ts";
import { numberReferences } from "./references.ts";
import { factsPanels, planOf, recordOf, relatednessOfPlan, testNumbers } from "./evaluate.ts";
import type { CapsuleFacts, FindingFact, PanelFile, PanelIndexEntry } from "./facts.ts";
import { SECTION_IDS, SECTION_TITLES, UNTESTED_NOTE, validateThesisDoc } from "./validate.ts";
import { renderThesisMarkdown } from "./render.ts";

/** Bumped when the generator's output for the same inputs changes. Part of the version hash. */
export const GENERATOR_VERSION = "user-thesis-3";

export interface HypothesisInput {
  id: string;
  status: "frozen" | "draft";
  proposition: string;
  falsification: string | null;
  /** The test plan stored with the hypothesis (nullable: older and manually written hypotheses have none). */
  testPlan?: TestPlan | null;
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
  /**
   * The test plan an agent task locked before the investigation ran (verified against the stored task by the route);
   * absent for a thesis built outside the agent, which then records `lockedAt: null`.
   */
  planLock?: PlanLock | null;
}
/** What a locked task plan adds to the document's test plan. */
export interface PlanLock {
  /** ISO time the plan was locked (the task's Start). */
  lockedAt: string;
  /** sha256 of the canonical plan as the task stored it. */
  sha256: string;
  editedByUser: boolean;
  wouldCountAsWrong: string;
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
      rule: RULE_V2_ID,
      capsuleId: i.facts.capsuleId,
      capsuleHash: i.facts.capsuleHash,
      runId: i.runId,
      capsuleStatus: i.capsuleStatus,
      hypothesis: i.hypothesis,
      monitors: i.monitors,
      markers: i.markers,
      outlayer: i.outlayer,
      // only a locked plan changes the version, so every thesis built without one keeps its id
      ...(i.planLock ? { planLock: i.planLock } : {}),
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

/**
 * The column a panel's sentence describes: the one the canvas encodes as y when the run recorded it, otherwise the column whose
 * name shares the most words with the panel's title (a "refund rate" panel is about its refund rate column), otherwise the first.
 */
export function primaryOf<T extends { name: string }>(
  series: T[],
  title: string,
  recorded?: string | null,
): T {
  if (recorded) {
    const hit = series.find((x) => x.name === recorded);
    if (hit) return hit;
  }
  const tt = new Set(concept(title));
  let best = series[0]!;
  let bs = 0;
  for (const x of series) {
    const sc = concept(x.name).filter((t) => tt.has(t)).length;
    if (sc > bs) {
      best = x;
      bs = sc;
    }
  }
  return best;
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
  const prim = primaryOf(series, pe.title, pe.primaryColumn);
  const isRatio = prim.unit !== null && /^(ratio|share|rate)$/i.test(prim.unit);
  const idx = prim.values.flatMap((v, i) => (v === null ? [] : [i]));
  const i0 = idx[0]!;
  const i1 = idx[idx.length - 1]!;
  let imax = i0;
  for (const i of idx) if (Number(prim.values[i]) > Number(prim.values[imax]!)) imax = i;
  const ptr = (i: number): string => `/chart/rows/${i}/${prim.ci}`;
  const xptr = (i: number): string => `/chart/rows/${i}/0`;
  const dayOf = (i: number): string =>
    isDay ? L.derived(file, "day", [xptr(i)], x[i]!) : L.s(file, xptr(i));
  // a ratio is shown as a percent (the unit word is dropped), every other column keeps its own unit
  const unitFn = (): string =>
    prim.unit && !isRatio ? ` ${L.s(file, `/chart/columns/${prim.ci}/unit`)}` : "";
  const show = (i: number): string =>
    isRatio ? L.n(file, ptr(i), (v) => `${fmt(v * 100)}%`) : L.n(file, ptr(i));
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
      `${label} went from ${show(i0)}${unitFn()} on ${dayOf(i0)} to ${show(i1)}${unitFn()} on ${dayOf(i1)}${pct}, ` +
      `with a peak of ${show(imax)}${unitFn()} on ${dayOf(imax)}.`
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
    primary: prim.name,
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
  /** The claim under test: the test plan's sentence. */
  hypothesis: string;
  verdict: {
    status: VerdictStatus;
    headline: string;
    comparison: {
      summary: string;
      rows: Array<{ label: string; value: string | null; unit: string | null; ref: string }>;
    };
    whatWouldChangeOurMind: string[];
    /** Exact pointers of each item of `whatWouldChangeOurMind`, same order. */
    whatWouldChangeOurMindRefs: string[][];
  };
  /** `references`: exact `file#pointer` of every marker `[n]` of the section's markdown (marker n is references[n - 1]). */
  sections: Array<{ id: string; title: string; markdown: string; references: string[] }>;
  claims: Array<Record<string, unknown>>;
  charts: Array<Record<string, unknown>>;
  tables: Array<{ name: string; system: string; purpose: string; columns: string[] }>;
  sampleQuery: { title: string; sql: string };
  unableToCompute: Array<{ what: string; why: string; refs: string[] }>;
  reproduce: Record<string, unknown>;
  files: Array<{ path: string; sha256: string; bytes?: number }>;
  grounding: { numbersChecked: number; references: number };
  origin: Record<string, unknown>;
  /** The earlier draft hypothesis of the workspace, shown as context and never as the claim under test. */
  context: { draftHypothesis: { status: string; proposition: string; falsification: string | null } | null };
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
const abs = (v: bigint): bigint => (v < 0n ? -v : v);
const sgn = (v: bigint): number => (v > 0n ? 1 : v < 0n ? -1 : 0);

export function buildThesis(inp: ThesisInputs): ThesisBuildOutput {
  const { facts } = inp;
  const sel = facts.index.selection;
  const version = thesisVersionOf(inp);
  const xPanel = facts.panels.get(sel.x.panelHash);
  const yPanel = facts.panels.get(sel.y.panelHash);
  if (!xPanel || !yPanel)
    throw new ThesisBuildError("the capsule index names a panel that is not in the capsule");

  const { plan, chosenBy, named } = planOf(facts);
  const tn = testNumbers(facts.results, facts.input, plan.lagDays, facts.capsuleHash);
  const { stats } = tn;
  const n = tn.n;
  const levelPpm = tn.levelPpm;
  if (levelPpm !== null && stats.levelPpm !== null && levelPpm !== stats.levelPpm)
    throw new ThesisBuildError(
      "the level correlation recomputed from the series differs from the capsule's result",
    );
  const window = { from: facts.input.series.x.points[0]![0], to: facts.input.series.x.points.at(-1)![0] };
  const covX = coverageOf(xPanel, window);
  const covY = coverageOf(yPanel, window);
  const coverageComplete =
    covX.complete === null || covY.complete === null ? null : covX.complete && covY.complete;
  const rel: Relatedness = relatednessOfPlan(factsPanels(facts), plan) ?? {
    status: "independent",
    code: "INDEPENDENT",
    reason: "The two series could not be re-read from the stored panels to check for a mechanical relation.",
    notes: [],
    heuristic: true,
  };
  const iv = stats.interval;
  const rule = evaluateRuleV2({
    n: tn.pairs,
    levelPpm,
    changePpm: stats.changePpm,
    interval: iv,
    expectedSign: plan.expectedSign,
    coverageComplete,
    mechanical: rel.status === "mechanical",
  });
  const status = rule.status;
  const exp = plan.expectedSign === "positive" ? 1 : plan.expectedSign === "negative" ? -1 : 0;
  const otherWay = rule.codes.includes("POINTS_OTHER_WAY");

  // ledger files
  const files = new Map<string, Json>();
  files.set("results.json", J(facts.results));
  files.set("run-panels.json", J(facts.index));
  files.set("findings.json", J(facts.findings));
  files.set("rule.json", J(RULE_V2));
  files.set("plan.json", J({ ...plan, namedForQuestion: named, pairChosenBy: chosenBy }));
  files.set(
    "stats.json",
    J({
      pairs: tn.pairs,
      lagDays: plan.lagDays,
      seed: facts.capsuleHash.slice(0, 8),
      bootstrap: { resamples: BOOTSTRAP.resamples, blockDays: BOOTSTRAP.blockLength },
      ...(stats.changePpm !== null ? { changePpm: stats.changePpm.toString() } : {}),
      ...(stats.spearmanPpm !== null ? { spearmanPpm: stats.spearmanPpm.toString() } : {}),
      ...(iv ? { interval: { loPpm: iv.loPpm.toString(), hiPpm: iv.hiPpm.toString() } } : {}),
    }),
  );
  files.set("relatedness.json", J(rel));
  files.set("capsule.json", J({ id: facts.capsuleId, hash: facts.capsuleHash, label: facts.label }));
  files.set("hypothesis.json", J(inp.hypothesis ?? {}));
  files.set("monitors.json", J(inp.monitors));
  files.set("markers.json", J(inp.markers));
  files.set("previous.json", J(inp.previous ?? {}));
  for (const p of facts.index.panels) files.set(panelFileName(p.hash), J(facts.panels.get(p.hash)));
  const L = new Ledger(files);

  const R = "results.json";
  const PL = "plan.json";
  const ST = "stats.json";
  const xName = (): string => L.s(PL, "/x/column");
  const yName = (): string => L.s(PL, "/y/column");
  const nText = (): string => L.n(R, "/n");
  const fromTo = (): string =>
    `${L.derived(R, "window", ["/n"], window.from)} to ${L.derived(R, "window", ["/n"], window.to)}`;
  const levelPtr = plan.lagDays > 0 ? `/lag_pearson_ppm/${plan.lagDays}` : "/pearson_ppm";
  const lvText = (): string => L.n(R, levelPtr, ppmText);
  const sameDayText = (): string => L.n(R, "/pearson_ppm", ppmText);
  const lag7Text = (): string => L.n(R, `/lag_pearson_ppm/${RULE_V2.lagDays}`, ppmText);
  const chText = (): string => L.n(ST, "/changePpm", ppmText);
  const spText = (): string => L.n(ST, "/spearmanPpm", ppmText);
  const loText = (): string => L.n(ST, "/interval/loPpm", ppmText);
  const hiText = (): string => L.n(ST, "/interval/hiPpm", ppmText);
  const pairsText = (): string => L.n(ST, "/pairs");
  const ruleN = (k: keyof typeof RULE_V2, show?: (x: number) => string): string =>
    L.n("rule.json", `/${k}`, show);
  const ruleP = (k: keyof typeof RULE_V2): string => ruleN(k, ppmText);
  const line = (fn: () => string): string => L.line(fn);
  const planStatement = (): string => oneLine(L.s(PL, "/statement"));
  const intervalText = (): string => `${ruleN("intervalPercent")}% interval ${loText()} to ${hiText()}`;
  const hasChange = stats.changePpm !== null;
  const hasInterval = iv !== null;

  // ---- charts
  const unable: Array<{ what: string; why: string; refs: string[] }> = [];
  const builds: ChartBuild[] = [];
  facts.index.panels.forEach((pe, pi) => {
    const r = buildChart(facts, L, pe, pi);
    if (r.build) builds.push(r.build);
    else if (r.unable) unable.push({ what: `Chart: ${r.unable.split(":")[0]}`, why: r.unable, refs: [] });
  });
  for (const b of builds)
    if (String(b.chart.sqlExecuted).includes("no executed query was stored"))
      unable.push({
        what: `Executed query of ${String(b.chart.title)}`,
        why: "No executed query was stored with this panel's result, so the chart shows the stored result only.",
        refs: [],
      });

  // ---- findings sorted against the claim (heuristic: shared words and short phrase lists)
  const fIdx = facts.findings.map((f, i) => ({ f, i }));
  const relOf = relationOfFindings(facts.findings, plan.x.column, plan.y.column, plan.expectedSign);
  const supportingF = fIdx.filter((x) => relOf[x.i] === "supports");
  const contradictingF = fIdx.filter((x) => relOf[x.i] === "contradicts");
  const qualifyingF = fIdx.filter((x) => relOf[x.i] === "qualifies");
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

  // ---- evidence for / against (test numbers)
  const forTests: string[] = [];
  const againstTests: string[] = [];
  const againstFns: Array<() => string> = [];
  const addAgainst = (fn: () => string): void => {
    againstFns.push(fn);
    againstTests.push(line(() => `- ${fn()}`));
  };
  const addFor = (fn: () => string): void => void forTests.push(line(() => `- ${fn()}`));
  const signWord = exp === 0 ? "a" : "the expected";
  if (rel.status === "mechanical") {
    addAgainst(
      () =>
        `The two series are mechanically related, so no number below can test the claim: ${oneLine(L.s("relatedness.json", "/reason"))}`,
    );
  } else {
    if (levelPpm !== null) {
      const okSign = exp === 0 || sgn(levelPpm) === exp;
      if (!okSign)
        addAgainst(
          () => `The level correlation ${lvText()} has the opposite sign to the one the plan expects.`,
        );
      else if (abs(levelPpm) >= BigInt(RULE_V2.supportedLevelPpm))
        addFor(
          () =>
            `The level correlation ${lvText()} has ${signWord} sign and an absolute value of at least ${ruleP("supportedLevelPpm")}.`,
        );
      else
        addAgainst(
          () =>
            `The level correlation ${lvText()} is below ${ruleP("supportedLevelPpm")} in absolute value, the level the rule needs for support.`,
        );
    }
    if (hasInterval && levelPpm !== null) {
      const excludes = iv!.loPpm > 0n || iv!.hiPpm < 0n;
      const side = iv!.loPpm > 0n ? 1 : -1;
      if (excludes && (exp === 0 ? side === sgn(levelPpm) : side === exp))
        addFor(() => `The ${intervalText()} for the level correlation excludes zero.`);
      else if (excludes)
        addAgainst(
          () =>
            `The ${intervalText()} for the level correlation lies wholly on the other side of zero from the expected sign: the data point the other way.`,
        );
      else addAgainst(() => `The ${intervalText()} for the level correlation includes zero.`);
    }
    if (hasChange && levelPpm !== null) {
      if (
        abs(stats.changePpm!) >= BigInt(RULE_V2.supportedChangePpm) &&
        sgn(stats.changePpm!) === sgn(levelPpm)
      )
        addFor(
          () =>
            `The correlation of day-over-day changes ${chText()} has the same sign as the level correlation and an absolute value of at least ${ruleP("supportedChangePpm")}.`,
        );
      else
        addAgainst(
          () =>
            `The correlation of day-over-day changes ${chText()} is below ${ruleP("supportedChangePpm")} in absolute value or has the opposite sign to the level correlation, so the movement of the levels may come from trends shared by both series.`,
        );
    }
    if (stats.spearmanPpm !== null && levelPpm !== null) {
      if (
        sgn(stats.spearmanPpm) === sgn(levelPpm) &&
        abs(stats.spearmanPpm) >= BigInt(RULE_V2.supportedLevelPpm)
      )
        addFor(
          () =>
            `The rank (Spearman) correlation ${spText()} has the same sign as the level correlation and is at least ${ruleP("supportedLevelPpm")} in absolute value.`,
        );
      else if (sgn(stats.spearmanPpm) !== sgn(levelPpm))
        addAgainst(
          () => `The rank (Spearman) correlation ${spText()} has the opposite sign to the level correlation.`,
        );
    }
    if (tn.pairs >= RULE_V2.supportedMinDays)
      addFor(
        () =>
          `The series share ${pairsText()} aligned days, at least the ${ruleN("supportedMinDays")} the rule needs for support.`,
      );
    else
      addAgainst(
        () =>
          `The series share ${pairsText()} aligned days, fewer than the ${ruleN("supportedMinDays")} the rule needs for support.`,
      );
    if (coverageComplete !== true)
      addAgainst(
        () =>
          `The coverage of the days used is ${coverageComplete === null ? "not stated" : "not complete"} for at least one of the two panels (${xName()}: ${covX.detail}; ${yName()}: ${covY.detail}).`,
      );
    rel.notes.forEach((_, k) =>
      addAgainst(() => `Note (heuristic check): ${oneLine(L.s("relatedness.json", `/notes/${k}`))}`),
    );
  }

  // skeptic notes and limitations: deduplicated, grouped, at most three per group in the text
  const noteItems: NoteItem[] = [];
  fIdx.forEach(({ f, i }) => {
    f.skepticNotes.forEach((t, k) =>
      noteItems.push({ text: t, pointer: `/${i}/skepticNotes/${k}`, kind: "skeptic" }),
    );
    f.limitations.forEach((t, k) =>
      noteItems.push({ text: t, pointer: `/${i}/limitations/${k}`, kind: "limitation" }),
    );
  });
  const grouped = groupNotes(noteItems);
  const noteLines: string[] = [];
  for (const g of NOTE_GROUPS) {
    const items = grouped[g];
    if (!items.length) continue;
    noteLines.push(`**${GROUP_TITLE[g]}**`);
    for (const it of items.slice(0, 3))
      noteLines.push(
        line(
          () =>
            `> ${it.kind === "skeptic" ? "Skeptic note" : "Limitation recorded with a finding"}: ${oneLine(L.s("findings.json", it.pointer))}`,
        ),
      );
    if (items.length > 3) {
      const more = items.length - 3;
      noteLines.push(
        line(
          () =>
            `- ${L.count("findings.json", items[3]!.pointer, more)} more ${GROUP_TITLE[g].toLowerCase()} notes in the capsule (findings.json).`,
        ),
      );
    }
  }

  // ---- monitors/markers
  const watching = inp.monitors.map((m, i) => ({ m, i })).filter((x) => x.m.watchesSeries);

  // ---- comparison rows
  const rows: ThesisDocument["verdict"]["comparison"]["rows"] = [];
  const addRow = (label: string, value: string | null, unit: string | null, ref: string): void => {
    rows.push({ label, value, unit, ref });
  };
  addRow("Aligned daily points", String(n), "days", `${R}#/n`);
  addRow(
    plan.lagDays > 0 ? `Level correlation at a lag of ${plan.lagDays} days` : "Same-day level correlation",
    levelPpm === null ? null : ppmText(levelPpm),
    "ratio",
    `${R}#${levelPtr}`,
  );
  if (plan.lagDays > 0)
    addRow(
      "Same-day level correlation",
      tn.pearsonPpm === null ? null : ppmText(tn.pearsonPpm),
      "ratio",
      `${R}#/pearson_ppm`,
    );
  if (plan.lagDays !== RULE_V2.lagDays)
    addRow(
      `Level correlation at a lag of ${RULE_V2.lagDays} days`,
      tn.lag7Ppm === null ? null : ppmText(tn.lag7Ppm),
      "ratio",
      `${R}#/lag_pearson_ppm/${RULE_V2.lagDays}`,
    );
  addRow(
    "Correlation of day-over-day changes",
    hasChange ? ppmText(stats.changePpm!) : null,
    "ratio",
    `${ST}#/changePpm`,
  );
  addRow(
    "Rank (Spearman) correlation of levels",
    stats.spearmanPpm === null ? null : ppmText(stats.spearmanPpm),
    "ratio",
    `${ST}#/spearmanPpm`,
  );
  if (iv) {
    addRow(
      `Interval low (${RULE_V2.intervalPercent}%, level correlation)`,
      ppmText(iv.loPpm),
      "ratio",
      `${ST}#/interval/loPpm`,
    );
    addRow(
      `Interval high (${RULE_V2.intervalPercent}%, level correlation)`,
      ppmText(iv.hiPpm),
      "ratio",
      `${ST}#/interval/hiPpm`,
    );
  }
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
        return `there are ${pairsText()} aligned days, fewer than the ${ruleN("minDays")} the rule needs`;
      case "COVERAGE_NOT_COMPLETE":
        return `the coverage of the days used is ${coverageComplete === null ? "not stated" : "not complete"} for at least one of the two panels`;
      case "CORRELATION_UNDEFINED":
        return "the correlation is undefined for these series";
      default:
        return "";
    }
  };
  const levelWord =
    plan.lagDays > 0 ? `${L.n(PL, "/lagDays")}-day-lag level correlation` : "same-day level correlation";
  const headlineFn = (): string => {
    const names = `${xName()} and ${yName()}`;
    if (status === "INVALID_TEST")
      return `INVALID_TEST: ${names} are mechanically related, so they cannot test the claim: ${oneLine(L.s("relatedness.json", "/reason"))} This is a heuristic check.`;
    if (status === "INSUFFICIENT_DATA")
      return `INSUFFICIENT_DATA: the stored data do not let the relationship rule judge ${names}: ${rule.codes.map(reasonSentence).filter(Boolean).join("; ")}.`;
    return (
      `${status}${otherWay ? " (the data point the other way)" : ""}: for ${names} over ${nText()} aligned days (${fromTo()}) the ${levelWord} is ${lvText()}` +
      `${hasInterval ? ` (${intervalText()})` : ""}${hasChange ? ` and the correlation of day-over-day changes is ${chText()}` : ""}; this is a descriptive rule, not a significance test, and it does not show cause.`
    );
  };
  const head = L.collect(headlineFn);
  const summaryFn = (): string =>
    levelPpm === null
      ? `No correlation could be computed for ${xName()} and ${yName()}.`
      : `${xName()} and ${yName()} share ${nText()} aligned days; the ${levelWord} is ${lvText()}${hasInterval ? ` (${intervalText()})` : ""}${hasChange ? `, the correlation of day-over-day changes is ${chText()}` : ""}${stats.spearmanPpm !== null ? ` and the rank correlation is ${spText()}` : ""}.`;
  const summary = L.collect(summaryFn);

  // ---- what would change our mind
  const changeMind: string[] = [];
  if (
    inp.hypothesis?.testPlan &&
    inp.hypothesis.falsification &&
    inp.hypothesis.testPlan.statement === plan.statement
  )
    changeMind.push(
      line(
        () =>
          `- The author's falsification criterion (${L.s("hypothesis.json", "/status")} hypothesis): ${oneLine(L.s("hypothesis.json", "/falsification"))}`,
      ),
    );
  changeMind.push(
    line(
      () =>
        `- A level correlation below ${ruleP("notSupportedBelowPpm")} in absolute value whose ${ruleN("intervalPercent")}% interval includes zero, over at least ${ruleN("minDays")} complete aligned days, would give NOT_SUPPORTED.`,
    ),
  );
  if (exp !== 0)
    changeMind.push(
      line(
        () =>
          `- A ${ruleN("intervalPercent")}% interval wholly on the ${exp > 0 ? "negative" : "positive"} side of zero (the data point the other way) would give NOT_SUPPORTED.`,
      ),
    );
  changeMind.push(
    line(
      () =>
        `- A level correlation of ${exp === 0 ? "either sign" : exp > 0 ? "positive sign" : "negative sign"} with absolute value at least ${ruleP("supportedLevelPpm")}, an interval that excludes zero, and a correlation of day-over-day changes of the same sign with absolute value at least ${ruleP("supportedChangePpm")}, over at least ${ruleN("supportedMinDays")} complete aligned days, would give SUPPORTED.`,
    ),
  );
  changeMind.push(
    line(
      () =>
        `- Fewer than ${ruleN("minDays")} aligned days, or incomplete coverage of the days used, gives INSUFFICIENT_DATA whatever the correlation is.`,
    ),
  );
  changeMind.push(
    "- Finding that one series is a part of the other, a duplicate of it, or the numerator of a ratio it is tested against gives INVALID_TEST whatever the correlation is.",
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
  const VERDICT_TEXT: Record<VerdictStatus, string> = {
    SUPPORTED: "the data support the claim under the relationship-v2 rule",
    MIXED: "the data fit the claim only partly; not every threshold for support was met",
    NOT_SUPPORTED: otherWay
      ? "the data point the other way from the claim"
      : "the data do not support the claim: the correlation is too weak to tell it from zero",
    INSUFFICIENT_DATA: "the stored data do not let the rule give a verdict",
    INVALID_TEST: "the two series are mechanically related, so this test cannot judge the claim",
  };
  const selectionLine = (): string =>
    named
      ? `Test pair named for the question by ${L.s(PL, "/chosenBy")}: ${oneLine(L.s(PL, "/why"))}`
      : "Pair chosen by rule, not named for the question: the original longest-overlap rule picked the two series, so the sentence above is a default and the pair may not be the one the question asks about.";
  sec.set(
    "executive-claim",
    [
      `Verdict **${status}**: ${VERDICT_TEXT[status]}.`,
      line(() => `> Claim under test: ${planStatement()}`),
      line(selectionLine),
      line(summaryFn),
      status === "INSUFFICIENT_DATA"
        ? line(() => `Reason: ${rule.codes.map(reasonSentence).filter(Boolean).join("; ")}.`)
        : "",
      status === "INVALID_TEST"
        ? line(
            () =>
              `Reason: ${oneLine(L.s("relatedness.json", "/reason"))} No verdict on the claim is given; ask for two series that are not part of each other. This check is a heuristic on names and values.`,
          )
        : "",
      inp.hypothesis && inp.hypothesis.proposition !== plan.statement
        ? "The workspace's earlier draft hypothesis is shown as context under Long-term economic mechanisms; it is not the claim under test."
        : "",
      "Evidence for and Evidence against have their own sections. This is a descriptive correlation rule, not a significance test, and a correlation does not show cause.",
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
          `The run produced ${L.count("run-panels.json", "/panels", facts.index.panels.length)} result panel(s); the test uses ${xName()} (predictor) and ${yName()} (outcome) over ${nText()} aligned days (${fromTo()}). Run source: ${L.s("run-panels.json", "/runSource")}.`,
      ),
      "| Panel | Source | Window | State | Metric version |\n|---|---|---|---|---|",
      ...panelRows,
    ].join("\n"),
  );
  const roundLines = (["x", "y"] as const).flatMap((k) =>
    sel.rounding?.[k]
      ? [
          line(
            () =>
              `Series ${k === "x" ? xName() : yName()} needed more decimal places than the verifier can scale exactly, so its values were rounded half-even to ${L.n("run-panels.json", `/selection/rounding/${k}/decimalsKept`)} decimal places before scaling; the largest absolute rounding difference is ${L.s("run-panels.json", `/selection/rounding/${k}/maxAbsRoundingDifference`)}.`,
          ),
        ]
      : [],
  );
  sec.set(
    "methods",
    [
      line(
        () =>
          `The test is ${RULE_V2_ID}, a descriptive correlation rule with constants fixed before any run: at least ${ruleN("minDays")} aligned days for any verdict; for SUPPORTED at least ${ruleN("supportedMinDays")} days, a level correlation of the expected sign with absolute value at least ${ruleP("supportedLevelPpm")}, a ${ruleN("intervalPercent")}% interval that excludes zero, and a correlation of day-over-day changes of the same sign with absolute value at least ${ruleP("supportedChangePpm")}; NOT_SUPPORTED when the interval includes zero and the absolute level correlation is below ${ruleP("notSupportedBelowPpm")}, or when the interval lies wholly on the other side of zero from the expected sign.`,
      ),
      line(
        () =>
          `Test plan: ${xName()} (predictor) against ${yName()} (outcome), relation ${L.s(PL, "/relation")}${plan.lagDays > 0 ? `, ${L.n(PL, "/lagDays")} days apart` : ""}, expected sign ${L.s(PL, "/expectedSign")}. ${selectionLine()}`,
      ),
      inp.planLock
        ? `The test plan (statement, the two series, relation, expected sign and what would count as wrong) was locked at ${inp.planLock.lockedAt} (sha256 ${inp.planLock.sha256}), before the investigation ran; ${inp.planLock.editedByUser ? "the user edited it" : "it was written by the planner and not edited"} and it did not change afterwards.`
        : "",
      line(
        () =>
          `Series choice (capsule rule, version ${L.n("run-panels.json", "/selection/ruleVersion")}): ${named ? "an explicit or question-matching pair, validated against the real candidate series." : L.s("run-panels.json", "/selection/rule")} Here ${L.count("run-panels.json", "/selection/candidates", sel.candidates.length)} candidate series were found and the chosen pair shares ${L.n("run-panels.json", "/selection/overlapDays")} consecutive days${sel.truncatedToLatest ? ", of which the latest are kept" : ""}.`,
      ),
      ...roundLines,
      line(
        () =>
          `Attested by the capsule's pinned verifier (and by the WASM cross-check and the OutLayer proof when present): the number of aligned days and the same-day and ${ruleN("lagDays")}-day-lag level correlations, as exact integers in parts per million. Recomputed by the API in exact integer arithmetic on every Verify and Rerun, and NOT part of that attestation: the correlation of day-over-day changes (first differences), the rank (Spearman) correlation of levels, the ${ruleN("intervalPercent")}% interval (a moving-block bootstrap with blocks of ${L.n(ST, "/bootstrap/blockDays")} days, ${L.n(ST, "/bootstrap/resamples")} resamples and the fixed seed ${L.s(ST, "/seed")} taken from the capsule hash, so the same capsule always gives the same interval) and the check for mechanically related series, which is a heuristic on names and values, not a proof. Percent changes are first to last day. This is a descriptive correlation rule, not a significance test.`,
      ),
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  const bench = [
    "| Quantity | Value | Unit |\n|---|---|---|",
    line(() => `| Aligned daily points | ${nText()} | days |`),
    levelPpm === null
      ? `| ${plan.lagDays > 0 ? "Level correlation at the plan's lag" : "Same-day level correlation"} | not computable | ratio |`
      : line(
          () =>
            `| ${plan.lagDays > 0 ? `Level correlation at a lag of ${L.n(PL, "/lagDays")} days` : "Same-day level correlation"} | ${lvText()} | ratio |`,
        ),
    ...(plan.lagDays > 0 && tn.pearsonPpm !== null
      ? [line(() => `| Same-day level correlation | ${sameDayText()} | ratio |`)]
      : []),
    ...(plan.lagDays !== RULE_V2.lagDays
      ? [
          tn.lag7Ppm === null
            ? `| Level correlation at a lag of ${RULE_V2.lagDays} days | not computable | ratio |`
            : line(
                () => `| Level correlation at a lag of ${ruleN("lagDays")} days | ${lag7Text()} | ratio |`,
              ),
        ]
      : [
          tn.lag7Ppm === null
            ? `| Level correlation at a lag of ${RULE_V2.lagDays} days | not computable | ratio |`
            : line(
                () => `| Level correlation at a lag of ${ruleN("lagDays")} days | ${lag7Text()} | ratio |`,
              ),
        ]),
    hasChange
      ? line(() => `| Correlation of day-over-day changes | ${chText()} | ratio |`)
      : "| Correlation of day-over-day changes | not computable | ratio |",
    stats.spearmanPpm !== null
      ? line(() => `| Rank (Spearman) correlation of levels | ${spText()} | ratio |`)
      : "| Rank (Spearman) correlation of levels | not computable | ratio |",
    hasInterval
      ? line(() => `| ${intervalText()} for the level correlation | ${loText()} to ${hiText()} | ratio |`)
      : "| Interval for the level correlation | not computable | ratio |",
    ...(["x", "y"] as const).map((k) =>
      facts.results[k]?.growth_bps == null
        ? `| ${cell(sel[k].column)} change, first to last day | not computable | percent |`
        : line(
            () =>
              `| ${cell(k === "x" ? xName() : yName())} change, first to last day | ${L.n(R, `/${k}/growth_bps`, (b) => (b / 100).toFixed(2))} | percent |`,
          ),
    ),
  ];
  // The lag-7 row repeats when the plan lag is 7: keep one
  const benchDedup = bench.filter(
    (l, i) =>
      !(
        plan.lagDays === RULE_V2.lagDays &&
        l.startsWith("| Level correlation at a lag of") &&
        bench.findIndex((m) => m.startsWith("| Level correlation at a lag of")) !== i &&
        false
      ),
  );
  sec.set("primary-benchmark", benchDedup.join("\n"));

  sec.set(
    "evidence-for",
    [
      ...forTests,
      ...supportingF.flatMap(quoteFinding),
      ...(forTests.length || supportingF.length
        ? []
        : ["No finding of the run and no test number favours the claim."]),
      "Findings are matched to the claim by shared words and a short list of phrases; this matching is a heuristic.",
    ].join("\n"),
  );
  const headsUp =
    contradictingF.length > 0
      ? [
          line(
            () =>
              `- Heuristic phrase match: ${L.count("findings.json", `/${contradictingF[0]!.i}/statement`, contradictingF.length)} finding(s) of this run say there is no general association between these series, which cuts against the ${status} verdict. They are quoted first.`,
          ),
        ]
      : [];
  const againstBody = [
    ...headsUp,
    ...contradictingF.flatMap(quoteFinding),
    ...againstTests,
    ...qualifyingF.flatMap(quoteFinding),
    ...noteLines,
  ];
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
      "- Two trending series correlate in their levels even when unrelated; that is why the rule also requires the day-over-day changes to move together.",
      named
        ? line(
            () =>
              `- The pair was named for the question rather than searched for among ${L.count("run-panels.json", "/selection/candidates", sel.candidates.length)} candidate series.`,
          )
        : line(
            () =>
              `- The pair was chosen by the original longest-overlap rule among ${L.count("run-panels.json", "/selection/candidates", sel.candidates.length)} candidate series, not named for the question, so a correlation of this size can arise by chance among the many pairs the rule could pick.`,
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
    inp.hypothesis
      ? [
          "Context, not the claim under test and not a result of this test; it carries no numbers of its own. The earlier draft hypothesis of this workspace reads:",
          line(() => `> ${oneLine(L.s("hypothesis.json", "/proposition"))}`),
        ].join("\n\n")
      : "No mechanism was stated for this workspace, and this thesis makes none.",
  );

  // ---- claims
  const claims: Array<Record<string, unknown>> = [];
  const claimRows: string[] = [];
  const pushClaim = (fill: () => Record<string, string | null>, kind: string, id: string): void => {
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
    () => ({
      statement: planStatement(),
      verdict: status,
      estimate:
        levelPpm === null
          ? "The level correlation could not be computed"
          : `${plan.lagDays > 0 ? "Level correlation at a lag of " + L.n(PL, "/lagDays") + " days" : "Same-day level correlation"} ${lvText()} over ${nText()} aligned days (${fromTo()})${hasChange ? `; correlation of day-over-day changes ${chText()}` : ""}`,
      uncertainty: hasInterval
        ? `${intervalText()} for the level correlation (moving-block bootstrap, recomputed by the API)`
        : "No interval could be computed",
      counterexample: againstFns.length ? againstFns[0]!() : "None recorded",
      falsification:
        inp.hypothesis?.testPlan &&
        inp.hypothesis.falsification &&
        inp.hypothesis.testPlan.statement === plan.statement
          ? oneLine(L.s("hypothesis.json", "/falsification"))
          : `NOT_SUPPORTED if the ${ruleN("intervalPercent")}% interval of the level correlation includes zero while its absolute value is below ${ruleP("notSupportedBelowPpm")}${exp !== 0 ? ", or if the interval lies wholly on the other side of zero" : ""}`,
      provenance: `capsule ${facts.capsuleId} (hash ${facts.capsuleHash}); rule ${RULE_V2_ID}; pair ${named ? "named for the question" : "chosen by rule, not named for the question"}`,
    }),
    "hypothesis",
    "claim-hypothesis",
  );
  for (const b of builds)
    pushClaim(
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
  if (inp.hypothesis)
    pushClaim(
      () => ({
        statement: "Earlier draft hypothesis of the workspace (section Long-term economic mechanisms)",
        verdict: "NOT TESTED",
        estimate: "None; context carries no numbers",
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

  // ---- unable to compute
  unable.unshift(
    {
      what: "Causal effect of one series on the other",
      why: "Excluded by design: the relationship-v2 rule is descriptive and a correlation does not show cause.",
      refs: [],
    },
    {
      what: "Significance test",
      why: "The relationship-v2 rule gives a bootstrap interval for the level correlation but no p-value or significance claim.",
      refs: [],
    },
    {
      what: "Any non-linear relation, any lag other than the plan's and the fixed seven-day lag, any out-of-sample forecast",
      why: "Only same-day and lagged Pearson correlations of levels and changes, one rank correlation and one interval are computed from the capsule's series.",
      refs: [],
    },
    {
      what: "Proof that two series are not mechanically related",
      why: "The check for part-of, duplicate and ratio relations is a heuristic on names and values; the metric registry's denominator is free text and is not machine-checkable.",
      refs: [],
    },
  );
  if (tn.lag7Ppm === null)
    unable.push({
      what: `Correlation at a lag of ${RULE_V2.lagDays} days`,
      why: "Not available in the capsule's results for these series.",
      refs: [`${R}#/lag_pearson_ppm`],
    });
  if (levelPpm === null)
    unable.push({
      what: "Level correlation",
      why: "Undefined for these series (a series is constant).",
      refs: [`${R}#/n`],
    });
  if (!hasInterval)
    unable.push({
      what: "Interval for the level correlation",
      why: "The bootstrap could not produce enough valid resamples for these series.",
      refs: [],
    });
  if (!inp.hypothesis)
    unable.push({
      what: "Earlier draft hypothesis",
      why: "The workspace has no hypothesis record; the claim is the test plan's sentence.",
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
      "- Verify: press Verify on the thesis page (or POST /v1/theses/{thesisId}/verify). It is free and runs no model and no chain call. It checks the document hash, every chart's data against the capsule's stored panel results, the capsule itself (raw hashes, recomputed metrics, WASM cross-check when available), the test numbers (the verifier's level correlations and the API's change, rank and interval numbers) recomputed from the frozen series, the mechanical-relation check, and the OutLayer proof state when one exists.",
      "- Reproduce: press Rerun to re-execute the stored queries over the frozen window and compare the numbers and the verdict.",
      "- Data: the aligned series and the recomputed results are served beside the document (data/daily_series.csv, data/verifier-input.json, data/results.json).",
    ].join("\n"),
  );
  const locOf = (name: string): { loc: string; h: string } => {
    if (name === "rule.json")
      return { loc: `constants of this document (rule ${RULE_V2_ID})`, h: sha(canonicalJson(RULE_V2)) };
    if (name === "plan.json" || name === "stats.json" || name === "relatedness.json")
      return {
        loc:
          name === "plan.json"
            ? "test plan of the capsule's selection record"
            : name === "stats.json"
              ? "numbers recomputed by the API from the frozen series"
              : "mechanical-relation check recomputed from the stored panels (heuristic)",
        h: sha(canonicalJson(files.get(name)!)),
      };
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
      "References in the numbered lists of each section are `file#pointer` into the files below, which are part of the capsule or are recorded in the document.",
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
              `This version: ${status}, ${nText()} aligned days${levelPpm !== null ? `, ${levelWord} ${lvText()}` : ""}.`,
          ),
        ].join("\n")
      : `First version of this workspace's thesis, id ${version}. The version id is derived from the hashes of its inputs, so any change in the capsule, the hypothesis, the monitors or the markers changes it.`,
  );

  // ---- scan (on the text with its inline pointers: the build fails on any number without a backing pointer)
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
  const claim = plan.statement;
  const outlayerBlock = inp.outlayer
    ? { status: inp.outlayer.status, requestId: inp.outlayer.requestId, txHash: inp.outlayer.txHash }
    : null;
  const mindRefs = changeMind.map((w) => numberReferences(w));
  const rawSections = SECTION_IDS.map((id, i) => ({
    id,
    title: SECTION_TITLES[i]!,
    markdown: sec.get(id)!.trim(),
  }));
  // wording and structure are validated on the text that still carries its pointers (quoted lines are recognised by them)
  const rawDoc = {
    verdict: {
      status,
      headline: head.text,
      whatWouldChangeOurMind: changeMind.map((w) => w.replace(/^- /, "")),
    },
    sections: rawSections,
    charts: builds.map((b) => b.chart),
  };
  const valid = validateThesisDoc(rawDoc);
  if (!valid.ok)
    throw new ThesisBuildError("the thesis failed wording or structure validation", valid.failures);
  const sections = rawSections.map((s) => {
    const r = numberReferences(s.markdown);
    return { id: s.id, title: s.title, markdown: r.markdown, references: r.references };
  });
  const doc: ThesisDocument = {
    schema: "nearesis.thesis.v1",
    version,
    generatedAt: inp.frozenAt,
    hypothesis: claim,
    verdict: {
      status,
      headline: head.text,
      comparison: { summary: summary.text, rows },
      whatWouldChangeOurMind: mindRefs.map((r) =>
        r.markdown.replace(/^- /, "").replace(/\s*(\[\d+\])+\s*$/, ""),
      ),
      whatWouldChangeOurMindRefs: mindRefs.map((r) => r.references),
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
    context: {
      draftHypothesis: inp.hypothesis
        ? {
            status: inp.hypothesis.status,
            proposition: inp.hypothesis.proposition,
            falsification: inp.hypothesis.falsification,
          }
        : null,
    },
    test: {
      rule: RULE_V2_ID,
      ruleText: RULE_V2_TEXT,
      // The plan as the capsule recorded it plus the fields the strength score reads. `lockedAt` is null unless an agent task
      // locked the plan at Start, before its investigation ran; a plan fixed when the capsule is built, after the run, is not
      // claimed to have been locked before the data was seen.
      plan: {
        ...plan,
        wouldCountAsWrong:
          inp.planLock?.wouldCountAsWrong ?? falsificationOf(plan.expectedSign, plan.lagDays),
        lockedAt: inp.planLock?.lockedAt ?? null,
        sha256: inp.planLock?.sha256 ?? sha(canonicalJson(plan)),
        editedByUser: inp.planLock?.editedByUser ?? false,
        resolved: {
          x: { panelHash: plan.x.panel, column: plan.x.column },
          y: { panelHash: plan.y.panel, column: plan.y.column },
        },
      },
      partOfWhole: rel.code === "PART_OF_WHOLE",
      pairSelection: {
        chosenBy,
        namedForQuestion: named,
        label: named ? null : "pair chosen by rule, not named for the question",
        capsuleRule: { version: sel.ruleVersion, text: sel.rule },
        candidates: sel.candidates.length,
        overlapDays: sel.overlapDays,
      },
      x: { name: sel.x.column, unit: sel.x.unit, panelHash: sel.x.panelHash },
      y: { name: sel.y.column, unit: sel.y.unit, panelHash: sel.y.panelHash },
      n,
      pairs: tn.pairs,
      window,
      pearson: tn.pearsonPpm === null ? null : ppmText(tn.pearsonPpm),
      pearsonPpm: tn.pearsonPpm === null ? null : tn.pearsonPpm.toString(),
      lag: [{ days: RULE_V2.lagDays, value: tn.lag7Ppm === null ? null : ppmText(tn.lag7Ppm) }],
      primary: { kind: plan.lagDays > 0 ? "lag" : "same_day", lagDays: plan.lagDays },
      ...recordOf(tn),
      relatedness: rel,
      rounding: sel.rounding ?? null,
      attestation: {
        attestedByVerifier: [
          "n",
          "same-day level correlation",
          `level correlation at a lag of ${RULE_V2.lagDays} days`,
          ...(plan.lagDays > 0 && plan.lagDays !== RULE_V2.lagDays
            ? [`level correlation at a lag of ${plan.lagDays} days`]
            : []),
        ],
        recomputedByApi: [
          "correlation of day-over-day changes",
          "rank (Spearman) correlation of levels",
          "bootstrap interval for the level correlation",
          "mechanical-relation check (heuristic)",
        ],
      },
      coverage: { x: covX, y: covY, complete: coverageComplete },
      reasons: rule.codes,
      thresholds: {
        ...RULE_V2,
        supportedLevel: ppmText(RULE_V2.supportedLevelPpm),
        supportedChange: ppmText(RULE_V2.supportedChangePpm),
        notSupportedBelow: ppmText(RULE_V2.notSupportedBelowPpm),
      },
      evidenceHeuristics: {
        findingMatching: "shared words of the two series' names plus a short list of phrases (heuristic)",
        contradictedByFinding: contradictingF.map((x) => x.i),
        supportedByFinding: supportingF.map((x) => x.i),
        qualifiedByFinding: qualifyingF.map((x) => x.i),
      },
    },
    verification: {
      capsule: { status: inp.capsuleStatus, checkedAt: inp.verifiedAt },
      outlayer: outlayerBlock,
    },
    monitors: inp.monitors,
    markers: inp.markers,
  };
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
