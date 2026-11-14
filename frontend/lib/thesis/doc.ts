import type {
  Thesis,
  ThesisBrief,
  ThesisChart,
  ThesisClaim,
  ThesisOrigin,
  ThesisRow,
  ThesisSection,
  ThesisTest,
  ThesisTestPlan,
  ThesisInterval,
  ThesisVerification,
} from '@/lib/thesis-track/model';

/**
 * Tolerant reader for a `nearesis.thesis.v1` document, whether it is the reference bundle or a workspace thesis.
 * Nothing is invented: a missing field stays missing (the viewer then says "unknown"), a wrongly typed field is dropped,
 * and a number is kept as the exact string the API sent.
 */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A number-like value as its exact string. */
const numStr = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return v.trim();
  return null;
};
const intOrNull = (v: unknown): number | null => {
  const s = numStr(v);
  return s === null ? null : Math.trunc(Number(s));
};
const strings = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');

function rows(v: unknown): { summary: string | null; rows: ThesisRow[] } | null {
  if (!isRec(v)) return null;
  const out: ThesisRow[] = [];
  for (const r of arr(v.rows)) {
    if (!isRec(r)) continue;
    const label = str(r.label) ?? str(r.name) ?? str(r.measure);
    if (!label) continue;
    out.push({ label, value: numStr(r.value) ?? str(r.value), unit: str(r.unit), ref: str(r.ref) });
  }
  return { summary: str(v.summary), rows: out };
}

function sections(v: unknown): ThesisSection[] {
  const out: ThesisSection[] = [];
  for (const s of arr(v)) {
    if (!isRec(s)) continue;
    const id = str(s.id);
    if (!id) continue;
    const references = strings(s.references);
    out.push({ id, title: str(s.title) ?? id, markdown: typeof s.markdown === 'string' ? s.markdown : '', ...(references.length ? { references } : {}) });
  }
  return out;
}

function claims(v: unknown): ThesisClaim[] {
  const out: ThesisClaim[] = [];
  for (const c of arr(v)) {
    if (!isRec(c)) continue;
    const statement = str(c.statement);
    if (!statement) continue;
    out.push({
      id: str(c.id) ?? `claim-${out.length + 1}`,
      statement,
      kind: str(c.kind),
      verdict: str(c.verdict),
      estimate: str(c.estimate),
      uncertainty: str(c.uncertainty),
      counterexample: str(c.counterexample),
      falsification: str(c.falsification),
      refs: strings(c.refs),
    });
  }
  return out;
}

function charts(v: unknown): ThesisChart[] {
  const out: ThesisChart[] = [];
  for (const c of arr(v)) {
    if (!isRec(c)) continue;
    const id = str(c.id);
    if (!id) continue;
    const win = isRec(c.window) ? { from: str(c.window.from) ?? undefined, to: str(c.window.to) ?? undefined } : null;
    out.push({
      ...(c as object),
      id,
      title: str(c.title) ?? id,
      kind: str(c.kind) ?? undefined,
      unit: str(c.unit),
      sentence: str(c.sentence),
      evidenceAgainst: str(c.evidenceAgainst),
      x: arr(c.x).map((x) => String(x)),
      series: arr(c.series)
        .filter(isRec)
        .map((s) => ({
          name: str(s.name) ?? 'series',
          values: arr(s.values).map((y) => (y === null || y === undefined ? null : typeof y === 'number' || typeof y === 'string' ? String(y) : null)),
        })),
      window: win,
      caveats: strings(c.caveats),
      sha256: str(c.sha256),
      sqlExecuted: str(c.sqlExecuted),
      sqlBigQuery: str(c.sqlBigQuery),
      source: str(c.source),
    } as ThesisChart);
  }
  return out;
}

const humanKey = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();

/** Plain `key: value` pairs of a thresholds object; nested objects are flattened one level. */
export function thresholdPairs(v: unknown): { key: string; value: string }[] {
  if (!isRec(v)) return [];
  const out: { key: string; value: string }[] = [];
  for (const [k, x] of Object.entries(v)) {
    if (isRec(x)) for (const [k2, y] of Object.entries(x)) push(out, `${k} ${k2}`, y);
    else push(out, k, x);
  }
  return out;
}
function push(out: { key: string; value: string }[], k: string, v: unknown) {
  const s = numStr(v) ?? (typeof v === 'string' ? v : typeof v === 'boolean' ? String(v) : null);
  if (s !== null) out.push({ key: humanKey(k), value: s });
}

function seriesName(v: unknown): string | null {
  if (typeof v === 'string') return str(v);
  if (isRec(v)) return str(v.label) ?? str(v.name) ?? str(v.title) ?? str(v.id) ?? str(v.metric);
  return null;
}

/** `column` or `panel` names the resolved series; a plain string is taken as the name. */
/** A correlation in parts per million as a six-decimal string. */
function ppm(v: unknown): string | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? (n / 1_000_000).toFixed(6) : null;
}

function seriesLabel(plan: Rec, which: 'x' | 'y'): string | null {
  const v = plan[which];
  if (isRec(v)) return str(v.label) ?? resolvedName(v);
  return resolvedName(plan.resolved && isRec(plan.resolved) ? plan.resolved[which] : null);
}

function resolvedName(v: unknown): string | null {
  if (typeof v === 'string') return str(v);
  if (isRec(v)) {
    const panel = str(v.panel) ?? str(v.panelTitle) ?? str(v.label);
    const col = str(v.column);
    return panel && col ? `${panel} (${col})` : (panel ?? col);
  }
  return null;
}

export function testPlan(v: unknown): ThesisTestPlan | null {
  if (!isRec(v)) return null;
  const r = { x: seriesLabel(v, 'x'), y: seriesLabel(v, 'y') };
  return {
    statement: str(v.statement),
    why: str(v.why),
    relation: v.relation === 'moves_with' || v.relation === 'leads' ? v.relation : null,
    lagDays: intOrNull(v.lagDays),
    expectedSign: v.expectedSign === 'positive' || v.expectedSign === 'negative' || v.expectedSign === 'either' ? v.expectedSign : null,
    wouldCountAsWrong: str(v.wouldCountAsWrong),
    lockedAt: str(v.lockedAt),
    sha256: str(v.sha256),
    editedByUser: v.editedByUser === true,
    chosenBy: v.chosenBy === 'user' || v.chosenBy === 'planner' || v.chosenBy === 'rule' ? v.chosenBy : null,
    resolved: r.x || r.y ? r : null,
  };
}

function test(v: unknown): ThesisTest | null {
  if (!isRec(v)) return null;
  const w = isRec(v.window) ? { from: str(v.window.from), to: str(v.window.to) } : null;
  const lag: { days: number | null; value: string | null }[] = [];
  for (const l of arr(v.lag)) if (isRec(l)) lag.push({ days: intOrNull(l.days), value: numStr(l.value) });
  const val = (x: unknown): string | null => (isRec(x) ? (numStr(x.value) ?? (x.ppm !== undefined ? ppm(x.ppm) : null)) : numStr(x));
  const iv = isRec(v.interval)
    ? ({ lo: numStr(v.interval.lo), hi: numStr(v.interval.hi), levelPercent: intOrNull(v.interval.levelPercent), method: str(v.interval.method), blockDays: intOrNull(v.interval.blockDays), resamples: intOrNull(v.interval.resamples) } satisfies ThesisInterval)
    : null;
  const ps = isRec(v.pairSelection) ? { chosenBy: str(v.pairSelection.chosenBy), namedForQuestion: typeof v.pairSelection.namedForQuestion === 'boolean' ? v.pairSelection.namedForQuestion : null, label: str(v.pairSelection.label) } : null;
  const rel = isRec(v.relatedness) ? { status: str(v.relatedness.status), reason: str(v.relatedness.reason), notes: strings(v.relatedness.notes), heuristic: typeof v.relatedness.heuristic === 'boolean' ? v.relatedness.heuristic : null } : null;
  const rd = isRec(v.rounding)
    ? {
        rule: str(v.rounding.rule),
        series: Object.entries(v.rounding)
          .filter(([k, x]) => k !== 'rule' && isRec(x))
          .map(([k, x]) => ({ name: k, decimalsKept: intOrNull((x as Rec).decimalsKept), maxAbsRoundingDifference: numStr((x as Rec).maxAbsRoundingDifference) })),
      }
    : null;
  const at = isRec(v.attestation) ? { attestedByVerifier: strings(v.attestation.attestedByVerifier), recomputedByApi: strings(v.attestation.recomputedByApi) } : null;
  return {
    level: val(v.level),
    change: val(v.change),
    spearman: val(v.spearman),
    interval: iv,
    pairSelection: ps,
    relatedness: rel,
    partOfWhole: typeof v.partOfWhole === 'boolean' ? v.partOfWhole : null,
    rounding: rd,
    attestation: at,
    reasons: strings(v.reasons),
    plan: testPlan(v.plan),
    rule: str(v.rule),
    x: seriesName(v.x),
    y: seriesName(v.y),
    n: intOrNull(v.n),
    window: w,
    pearson: numStr(v.pearson),
    lag,
    thresholds: thresholdPairs(v.thresholds),
  };
}

function verification(v: unknown): ThesisVerification | null {
  if (!isRec(v)) return null;
  const c = isRec(v.capsule) ? { status: str(v.capsule.status), checkedAt: str(v.capsule.checkedAt) } : null;
  const o = isRec(v.outlayer) ? { status: str(v.outlayer.status), requestId: str(v.outlayer.requestId), txHash: str(v.outlayer.txHash) } : null;
  return { capsule: c, outlayer: o };
}

function origin(v: unknown): ThesisOrigin | null {
  if (!isRec(v)) return null;
  return {
    kind: str(v.kind),
    workspaceId: str(v.workspaceId),
    runId: str(v.runId),
    capsuleId: str(v.capsuleId),
    capsuleHash: str(v.capsuleHash),
    hypothesisId: str(v.hypothesisId),
  };
}

/** Fields that are plumbing, not reading: raw ids and hashes are never shown as lines. */
const PLUMBING = /(^id$|Ids?$|Hash$|^sha256$|^anchorType$|^watchesSeries$)/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const FROM_AGENT = /^from the assistant'?s investigation:\s*/i;

/** One monitor or marker brief: the first naming field is the title, every other plain field a short line. */
export function brief(v: unknown): ThesisBrief | null {
  if (typeof v === 'string') return str(v) ? { title: v.replace(FROM_AGENT, ''), lines: [] } : null;
  if (!isRec(v)) return null;
  const titleKey = ['title', 'name', 'label', 'rule', 'question', 'text', 'id'].find((k) => str(v[k]));
  const lines: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    if (k === titleKey || (PLUMBING.test(k) && titleKey !== undefined)) continue;
    const s = numStr(x) ?? str(x) ?? (typeof x === 'boolean' ? String(x) : null);
    if (s === null) continue;
    lines.push(`${humanKey(k)}: ${ISO.test(s) ? s.slice(0, 16).replace('T', ' ') + ' UTC' : typeof x === 'string' && /^[A-Z_]+$/.test(s) ? s.toLowerCase() : s}`);
  }
  const title = titleKey ? (str(v[titleKey]) as string).replace(FROM_AGENT, '') : lines.shift();
  return title ? { title, lines } : null;
}

const briefs = (v: unknown): ThesisBrief[] => arr(v).map(brief).filter((b): b is ThesisBrief => b !== null);

/** The document, or null when the value is not a thesis at all. */
export function normalizeDoc(raw: unknown): Thesis | null {
  if (!isRec(raw)) return null;
  if (raw.schema !== undefined && raw.schema !== 'nearesis.thesis.v1') return null;
  const v = isRec(raw.verdict) ? raw.verdict : null;
  const doc: Thesis = {
    schema: str(raw.schema) ?? undefined,
    version: str(raw.version) ?? undefined,
    generatedAt: str(raw.generatedAt) ?? undefined,
    hypothesis: str(raw.hypothesis) ?? undefined,
    verdict: v
      ? {
          status: str(v.status) ?? undefined,
          headline: str(v.headline) ?? undefined,
          intentsVsPrice: rows(v.intentsVsPrice),
          comparison: rows(v.comparison),
          whatWouldChangeOurMind: strings(v.whatWouldChangeOurMind),
        }
      : undefined,
    sections: sections(raw.sections),
    claims: claims(raw.claims),
    charts: charts(raw.charts),
    tables: arr(raw.tables)
      .filter(isRec)
      .map((t) => ({ name: str(t.name) ?? 'unknown', system: str(t.system), purpose: str(t.purpose), columns: strings(t.columns) })),
    sampleQuery: isRec(raw.sampleQuery) ? { title: str(raw.sampleQuery.title) ?? undefined, sql: str(raw.sampleQuery.sql) ?? undefined } : null,
    unableToCompute: arr(raw.unableToCompute)
      .map((u) => (typeof u === 'string' ? { what: u, why: null } : isRec(u) && str(u.what) ? { what: u.what as string, why: str(u.why) } : null))
      .filter((u): u is { what: string; why: string | null } => u !== null),
    reproduce: isRec(raw.reproduce)
      ? {
          command: str(raw.reproduce.command) ?? undefined,
          check: str(raw.reproduce.check) ?? undefined,
          hashes: arr(raw.reproduce.hashes)
            .filter(isRec)
            .map((h) => ({ path: str(h.path) ?? 'unknown', sha256: str(h.sha256) ?? 'unknown' })),
        }
      : null,
    files: arr(raw.files)
      .filter(isRec)
      .map((f) => ({ path: str(f.path) ?? 'unknown', sha256: str(f.sha256) ?? undefined, bytes: intOrNull(f.bytes) ?? undefined })),
    origin: origin(raw.origin),
    context: isRec(raw.context) ? { draftHypothesis: isRec(raw.context.draftHypothesis) ? { status: str(raw.context.draftHypothesis.status), proposition: str(raw.context.draftHypothesis.proposition), falsification: str(raw.context.draftHypothesis.falsification) } : null } : null,
    test: test(raw.test),
    verification: verification(raw.verification),
    monitors: briefs(raw.monitors),
    markers: briefs(raw.markers),
  };
  return doc;
}

/** Plain labels for the correlation rule's numbers (the document's `test` block). */
export function testRows(t: ThesisTest | null | undefined): { label: string; value: string }[] {
  if (!t) return [];
  const out: { label: string; value: string }[] = [];
  if (t.n !== null && t.n !== undefined) out.push({ label: 'Aligned days (n)', value: String(t.n) });
  if (t.window && (t.window.from || t.window.to)) out.push({ label: 'Window', value: `${t.window.from ?? 'unknown'} to ${t.window.to ?? 'unknown'}` });
  if (isV2(t)) {
    out.push({ label: 'Level correlation (same day)', value: t.level ?? t.pearson ?? 'unknown' });
    if (t.interval) out.push({ label: `${t.interval.levelPercent ?? 95}% interval for the level correlation`, value: intervalText(t.interval) });
    out.push({ label: 'Correlation of day-over-day changes', value: t.change ?? 'unknown' });
    out.push({ label: 'Rank (Spearman) correlation of levels', value: t.spearman ?? 'unknown' });
  } else {
    out.push({ label: 'Same-day correlation (Pearson)', value: t.pearson ?? 'unknown' });
  }
  for (const l of t.lag ?? []) out.push({ label: `Correlation at ${l.days === null ? 'unknown' : l.days}-day lag`, value: l.value ?? 'unknown' });
  return out;
}

/** A thesis built under the relationship-v2 rule (level, change and rank correlations with an interval). */
export const isV2 = (t: ThesisTest | null | undefined): boolean => !!t && (t.level !== undefined && t.level !== null);

export const intervalText = (i: ThesisInterval | null | undefined): string => (i && i.lo !== null && i.hi !== null ? `${i.lo} to ${i.hi}` : 'unknown');

const REASON_TEXT: Record<string, string> = {
  POINTS_OTHER_WAY: 'the data point the other way',
  THRESHOLDS_NOT_ALL_MET: 'not every threshold for support was met',
  LEVEL_BELOW_SUPPORT: 'the level correlation is below the level needed for support',
  INTERVAL_INCLUDES_ZERO: 'the interval around the level correlation includes zero',
  COVERAGE_NOT_COMPLETE: 'some of the days used are not complete',
  MECHANICALLY_RELATED: 'the two series are mechanically related',
};

/** A reason code as a plain phrase; an unknown code is lower-cased words, never hidden. */
export const reasonText = (code: string): string => REASON_TEXT[code] ?? code.toLowerCase().replace(/_/g, ' ');
