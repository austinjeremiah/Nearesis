import { ApiRequestError } from '@/lib/api/errors';
import { toNum } from '@/lib/data/num';

/**
 * View model for the NEAR Thesis page. The shapes mirror the `thesis.json` contract
 * (schema nearesis.thesis.v1). Every optional field is tolerated as missing: nothing here
 * invents a value, and an unknown value is shown as "unknown", never as 0.
 */

export type ThesisStatus = 'SUPPORTED' | 'NOT_SUPPORTED' | 'MIXED' | 'INSUFFICIENT_DATA';

export type ThesisRow = { label: string; value?: string | null; unit?: string | null; ref?: string | null };
/** `references` are the pointers behind the numbered markers [1], [2] … of the markdown (absent on older theses). */
export type ThesisSection = { id: string; title: string; markdown: string; references?: string[] };
export type ThesisClaim = {
  id: string;
  statement: string;
  kind?: string | null;
  verdict?: string | null;
  estimate?: string | null;
  uncertainty?: string | null;
  counterexample?: string | null;
  falsification?: string | null;
  refs?: string[];
};
export type ThesisChart = {
  id: string;
  title: string;
  kind?: 'line' | 'bar' | string;
  unit?: string | null;
  sentence?: string | null;
  evidenceAgainst?: string | null;
  x?: string[];
  series?: { name: string; values?: (string | null)[] }[];
  datasetIds?: string[];
  sqlExecuted?: string | null;
  sqlBigQuery?: string | null;
  bigQueryExecuted?: boolean;
  /** Optional on the wire; the SQL header also records it, see `bytesBilledOf`. */
  bigQueryBytesBilled?: string | number | null;
  source?: string | null;
  window?: { from?: string; to?: string } | null;
  caveats?: string[];
  sha256?: string | null;
};
export type ThesisTable = { name: string; system?: string | null; purpose?: string | null; columns?: string[] };
export type ThesisOrigin = {
  kind?: string | null;
  workspaceId?: string | null;
  runId?: string | null;
  capsuleId?: string | null;
  capsuleHash?: string | null;
  hypothesisId?: string | null;
};
/** The test plan a workspace thesis was locked to before the data was seen. */
export type ThesisTestPlan = {
  statement: string | null;
  /** Why this pair was chosen, in the planner's or the rule's words. */
  why?: string | null;
  relation: 'moves_with' | 'leads' | null;
  lagDays: number | null;
  expectedSign: 'positive' | 'negative' | 'either' | null;
  wouldCountAsWrong: string | null;
  lockedAt: string | null;
  sha256: string | null;
  editedByUser: boolean;
  chosenBy: 'user' | 'planner' | 'rule' | null;
  resolved: { x: string | null; y: string | null } | null;
};
export type ThesisInterval = { lo: string | null; hi: string | null; levelPercent: number | null; method: string | null; blockDays: number | null; resamples: number | null };
export type ThesisTest = {
  /** relationship-v2 fields; all absent on a v1 thesis. */
  level?: string | null;
  change?: string | null;
  spearman?: string | null;
  interval?: ThesisInterval | null;
  pairSelection?: { chosenBy: string | null; namedForQuestion: boolean | null; label: string | null } | null;
  relatedness?: { status: string | null; reason: string | null; notes: string[]; heuristic: boolean | null } | null;
  partOfWhole?: boolean | null;
  rounding?: { rule: string | null; series: { name: string; decimalsKept: number | null; maxAbsRoundingDifference: string | null }[] } | null;
  attestation?: { attestedByVerifier: string[]; recomputedByApi: string[] } | null;
  reasons?: string[];
  plan?: ThesisTestPlan | null;
  rule?: string | null;
  x?: string | null;
  y?: string | null;
  n?: number | null;
  window?: { from?: string | null; to?: string | null } | null;
  pearson?: string | null;
  lag?: { days: number | null; value: string | null }[];
  thresholds?: { key: string; value: string }[];
};
export type ThesisVerification = {
  capsule?: { status?: string | null; checkedAt?: string | null } | null;
  outlayer?: { status?: string | null; requestId?: string | null; txHash?: string | null } | null;
};
/** A monitor or marker in brief: a title and the mono detail lines the document carries for it. */
export type ThesisBrief = { title: string; lines: string[] };
export type Thesis = {
  schema?: string;
  version?: string;
  generatedAt?: string;
  /** A short name for the thesis (the reference thesis has one); the claim stays in `hypothesis`. */
  title?: string;
  question?: string;
  hypothesis?: string;
  verdict?: {
    status?: string;
    headline?: string;
    intentsVsPrice?: { summary?: string | null; rows?: ThesisRow[] } | null;
    /** Workspace theses carry this instead of `intentsVsPrice`. */
    comparison?: { summary?: string | null; rows?: ThesisRow[] } | null;
    whatWouldChangeOurMind?: string[];
  };
  origin?: ThesisOrigin | null;
  /** The draft hypothesis the run produced: context only, never the claim. */
  context?: { draftHypothesis?: { status: string | null; proposition: string | null; falsification: string | null } | null } | null;
  test?: ThesisTest | null;
  verification?: ThesisVerification | null;
  monitors?: ThesisBrief[];
  markers?: ThesisBrief[];
  sections?: ThesisSection[];
  claims?: ThesisClaim[];
  charts?: ThesisChart[];
  tables?: ThesisTable[];
  sampleQuery?: { title?: string; sql?: string } | null;
  unableToCompute?: { what: string; why?: string | null }[];
  reproduce?: { command?: string; check?: string; hashes?: { path: string; sha256: string }[] } | null;
  files?: { path: string; sha256?: string; bytes?: number }[];
};

export const THESIS_PATH = '/v1/thesis';
export const THESIS_MD_HREF = '/api/k/thesis/files/build/THESIS.md';
export const THESIS_SITE_HREF = '/api/k/thesis/files/build/site/index.html';
export const BUILD_COMMAND = 'pnpm thesis:build';

export const UNKNOWN = 'unknown';

/** Text or "unknown". Empty and null are both unknown. */
export function orUnknown(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return UNKNOWN;
  const s = String(v);
  return s.trim() === '' ? UNKNOWN : s;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | '';

export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'SUPPORTED':
      return 'ok';
    case 'NOT_SUPPORTED':
    case 'INVALID_TEST':
      return 'bad';
    case 'MIXED':
      return 'info';
    case 'INSUFFICIENT_DATA':
      return 'warn';
    default:
      return '';
  }
}

export function statusLabel(status: string | null | undefined): string {
  return status ? status.replace(/_/g, ' ') : UNKNOWN;
}

/** The 503 the API sends while no bundle exists: errorCode UPSTREAM_DEGRADED, reason THESIS_NOT_BUILT. */
export function isNotBuilt(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return error.reasonCode === 'THESIS_NOT_BUILT' || error.errorCode === 'THESIS_NOT_BUILT' || error.message.includes('THESIS_NOT_BUILT');
}

/**
 * Chart series for `SeriesChart`: one point per x, values kept as the exact strings from the bundle.
 * A missing or null value stays null (a gap); a short value array is padded with nulls, never zeros.
 */
export function chartSeries(chart: Pick<ThesisChart, 'x' | 'series'>): { name: string; points: { x: string; y: string | null }[] }[] {
  const xs = chart.x ?? [];
  return (chart.series ?? []).map((s) => ({
    name: s.name,
    points: xs.map((x, i) => {
      const v = s.values?.[i];
      return { x, y: v === undefined || v === null || v === '' ? null : v };
    }),
  }));
}

/** Count of points that actually carry a number, to tell an empty chart from a drawn one. */
export function observedPoints(chart: Pick<ThesisChart, 'x' | 'series'>): number {
  let n = 0;
  for (const s of chartSeries(chart)) for (const p of s.points) if (toNum(p.y) !== null) n += 1;
  return n;
}

/** Bytes as a binary-unit string (1 GiB = 1024^3). Input is the API's exact decimal string. */
export function formatBytes(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return UNKNOWN;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return UNKNOWN;
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let x = n;
  let u = -1;
  while (x >= 1024 && u < units.length - 1) {
    x /= 1024;
    u += 1;
  }
  return `${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)} ${units[u]}`;
}

/** Bytes billed for a chart: the explicit field, else the figure recorded in the SQL header comment. */
export function bytesBilledOf(chart: Pick<ThesisChart, 'bigQueryBytesBilled' | 'sqlBigQuery' | 'sqlExecuted'>): string | null {
  if (chart.bigQueryBytesBilled !== undefined && chart.bigQueryBytesBilled !== null && chart.bigQueryBytesBilled !== '') return String(chart.bigQueryBytesBilled);
  // per-dataset query records: the chart's figure is the sum over the BigQuery jobs that fed it
  const q = (chart as { queries?: Array<{ bigQueryExecuted?: boolean; bigQueryBytesBilled?: string | number | null }> }).queries;
  if (Array.isArray(q)) {
    const billed = q.filter((x) => x?.bigQueryExecuted && /^\d+$/.test(String(x.bigQueryBytesBilled ?? '')));
    if (billed.length) return billed.reduce((a, x) => a + BigInt(String(x.bigQueryBytesBilled)), 0n).toString();
  }
  for (const sql of [chart.sqlBigQuery, chart.sqlExecuted]) {
    const m = sql?.match(/bytes[ _]billed\D{0,12}(\d[\d,]*)/i);
    if (m) return m[1]!.replace(/,/g, '');
  }
  return null;
}

/** The tag on a chart's query block. Never claims execution unless the bundle says so. */
export function queryTag(chart: Pick<ThesisChart, 'bigQueryExecuted' | 'bigQueryBytesBilled' | 'sqlBigQuery' | 'sqlExecuted'>): { executed: boolean; text: string } {
  if (chart.bigQueryExecuted !== true) return { executed: false, text: 'Not executed in this build' };
  const b = bytesBilledOf(chart);
  return { executed: true, text: `Executed on BigQuery · ${b === null ? 'bytes billed unknown' : `${formatBytes(b)} billed`}` };
}

/* ------------------------------------------------------------------ sections */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export type SectionSlots = {
  evidenceFor: ThesisSection | null;
  evidenceAgainst: ThesisSection | null;
  changeMind: ThesisSection | null;
  rest: ThesisSection[];
};

/** Pick the three prominent sections by id (exact, then a tolerant match) and leave the rest in order. */
export function pickSections(sections: ThesisSection[] | undefined): SectionSlots {
  const all = sections ?? [];
  const find = (exact: string[], test: (id: string) => boolean) =>
    all.find((s) => exact.includes(norm(s.id))) ?? all.find((s) => test(norm(s.id))) ?? null;
  const evidenceFor = find(['evidence-for'], (id) => /evidence/.test(id) && /\bfor\b|-for$|-for-/.test(id));
  const evidenceAgainst = find(['evidence-against'], (id) => /evidence/.test(id) && /against/.test(id));
  const changeMind = find(['what-would-change-our-mind'], (id) => /change/.test(id) && /mind/.test(id));
  const used = new Set([evidenceFor, evidenceAgainst, changeMind].filter(Boolean) as ThesisSection[]);
  return { evidenceFor, evidenceAgainst, changeMind, rest: all.filter((s) => !used.has(s)) };
}

/** Drop a leading heading that repeats the card's own title, so it is not printed twice. */
export function stripLeadingHeading(markdown: string, title: string): string {
  const lines = markdown.replace(/^\s*\n/, '').split('\n');
  const m = lines[0]?.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
  if (m && norm(m[1]!) === norm(title)) return lines.slice(1).join('\n').replace(/^\s*\n/, '');
  return markdown;
}
