import type { Candidate } from "./workspace-run.ts";

/**
 * TEST PLAN of a workspace thesis: which two daily series test which sentence, and who chose them.
 *
 * Everything here is deterministic and model-free: question-matching chooser, mechanical-relation detection and the
 * validation of a pair proposed by a model (the proposal is only ever ids; it is checked against the real candidates).
 * The detection of mechanically related series is HEURISTIC (names and values of the stored series; the metric registry's
 * `denominator` is free text and is not machine-checkable), and the documents that use it say so.
 */

export type ChosenBy = "planner" | "user" | "rule";
export type Relation = "moves_with" | "leads";
export type ExpectedSign = "positive" | "negative" | "either";

/** A pair named by id: the panel's query hash and the column of its result table. */
export interface TestPair {
  panelHash: string;
  column: string;
}
/** An explicit test as the API accepts it (`POST /v1/workspaces/:id/capsules` and `/theses`). */
export interface TestRequest {
  x: TestPair;
  y: TestPair;
  /** Days by which x leads y (relation `leads`); absent or 0 means the same day. */
  lagDays?: number;
  expectedSign?: ExpectedSign;
  statement?: string;
  why?: string;
  chosenBy?: ChosenBy;
}
export interface PlanSeries {
  panel: string;
  panelTitle: string;
  column: string;
  label: string;
}
/** The recorded plan (`nearesis.thesis` test plan). */
export interface TestPlan {
  x: PlanSeries;
  y: PlanSeries;
  relation: Relation;
  lagDays: number;
  expectedSign: ExpectedSign;
  statement: string;
  chosenBy: ChosenBy;
  why: string;
}

export const MAX_LAG_DAYS = 30;

// ---- words -----------------------------------------------------------------------------------------------------------
const STOP = new Set(
  "a an the do does did have has had more less fewer higher lower than of in on to vs versus and or is are was were be by for with at as it its that this these those how what when which why there any between over per can from if so not no".split(
    " ",
  ),
);
/** Tokens that name no concept (every daily series has them). */
const GENERIC = new Set([
  "daily",
  "day",
  "count",
  "total",
  "number",
  "trend",
  "num",
  "live",
  "explorer",
  "period",
]);
/** A few plain synonyms for question words; each maps the word to column-name words. */
const SYNONYMS: Record<string, string[]> = {
  busy: ["swap", "volume", "transaction", "activity"],
  busier: ["swap", "volume", "transaction", "activity"],
  busiest: ["swap", "volume", "transaction", "activity"],
  activity: ["swap", "volume", "transaction"],
  traffic: ["swap", "transaction", "volume"],
  user: ["account", "address", "wallet"],
  customer: ["account", "address", "wallet"],
  price: ["price"],
};

const stem = (w: string): string => {
  let s = w.toLowerCase();
  if (s.length > 5 && s.endsWith("ful")) s = s.slice(0, -3);
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 4 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
};
/** Ordered, stemmed, de-stopped tokens of a text (camelCase, snake_case and dotted ids are split). */
export function tokensOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
}
export const concept = (text: string): string[] => tokensOf(text).filter((t) => !GENERIC.has(t));

/** Plain words of a column name or metric id for sentences: `refundRate` -> `refund rate`. */
export function humanize(column: string): string {
  const w = column
    .replace(/^[a-z_]+\./, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
  return w || column;
}

// ---- shared days -----------------------------------------------------------------------------------------------------
/** Longest run of consecutive days with a value in both series (earliest on ties). */
export function longestShared(a: Candidate, b: Candidate): number[] {
  const days = [...a.values.keys()].filter((d) => b.values.has(d)).sort((x, y) => x - y);
  let best: number[] = [];
  let cur: number[] = [];
  for (const d of days) {
    cur = cur.length && d === cur[cur.length - 1]! + 1 ? [...cur, d] : [d];
    if (cur.length > best.length) best = cur;
  }
  return best;
}
const sharedDays = (a: Candidate, b: Candidate): number[] =>
  [...a.values.keys()].filter((d) => b.values.has(d)).sort((x, y) => x - y);

// ---- mechanical relation (heuristic) ---------------------------------------------------------------------------------
export type RelatednessCode =
  "INDEPENDENT" | "IDENTICAL_SERIES" | "NEAR_DUPLICATE_SERIES" | "PART_OF_WHOLE" | "RATIO_OF_PREDICTOR";
export interface Relatedness {
  status: "independent" | "mechanical";
  code: RelatednessCode;
  /** Plain reason, without digits. */
  reason: string;
  /** Caveats that do not invalidate the test (for example the predictor is the denominator of the outcome). */
  notes: string[];
  heuristic: true;
}

const SEGMENT = new Set(
  [
    "success",
    "complet",
    "refund",
    "fail",
    "known",
    "unknown",
    "new",
    "return",
    "repeat",
    "exist",
    "settl",
    "paid",
    "pend",
    "cancel",
    "expir",
    "organic",
  ].flatMap((w) => [w, stem(w)]),
);
const TOTALISH = new Set(["active", "total", "all"].flatMap((w) => [w, stem(w)]));
const isRatioUnit = (u: string | null): boolean => u !== null && /^(ratio|percent|pct|share|rate)$/i.test(u);

const num = (v: string): number => Number(v);

/** Is `s` a part of `t` by name (a status or segment of the same thing)? */
function nameIsPartOf(s: Candidate, t: Candidate): boolean {
  const ts = concept(s.column);
  const tt = concept(t.column);
  if (!ts.length || !tt.length) return false;
  const modS = ts.filter((x) => SEGMENT.has(x));
  const baseS = ts.filter((x) => !SEGMENT.has(x) && !TOTALISH.has(x));
  const modT = tt.filter((x) => SEGMENT.has(x));
  const totT = tt.filter((x) => TOTALISH.has(x));
  const baseT = tt.filter((x) => !SEGMENT.has(x) && !TOTALISH.has(x));
  const sameSet = (p: string[], q: string[]): boolean =>
    p.length === q.length && p.every((x) => q.includes(x));
  // R1: same base, s carries a segment word, t carries none (or only a total word): newAccounts in activeAccounts
  if (modS.length && baseS.length && sameSet(baseS, baseT) && modT.length === 0) return true;
  // R2: s is a bare status word (success, refunded, new): a part of any total count it never exceeds
  if (modS.length && baseS.length === 0 && (baseT.length > 0 || totT.length > 0) && modT.length === 0)
    return true;
  // R3: t's name is contained in s's (swapsWithUnknownUsd in swaps)
  const setT = new Set(tt);
  if (ts.length > tt.length && tt.every((x) => ts.includes(x)) && !setT.has("")) return true;
  return false;
}

/**
 * Detects whether the test of `x` against `y` is mechanical: identical series, near-duplicate series, one a status or segment
 * subset of the other (values never exceed the whole on any shared day, same unit, names say part-of), or an outcome that is
 * a ratio whose numerator is the predictor. `siblings` are the other candidates of the panel(s) of x and y.
 */
export function relatednessOf(x: Candidate, y: Candidate, siblings: Candidate[] = []): Relatedness {
  const days = sharedDays(x, y);
  const out = (code: RelatednessCode, reason: string, notes: string[] = []): Relatedness => ({
    status: code === "INDEPENDENT" ? "independent" : "mechanical",
    code,
    reason,
    notes,
    heuristic: true,
  });
  const notes: string[] = [];
  if (days.length < 2) return out("INDEPENDENT", "Fewer than two shared days to compare the series.");
  const xs = days.map((d) => x.values.get(d)!);
  const ys = days.map((d) => y.values.get(d)!);
  if (xs.every((v, i) => v === ys[i]))
    return out("IDENTICAL_SERIES", "The two series have identical values on every shared day.");
  const sameUnit = x.unit === y.unit && !isRatioUnit(x.unit);
  const xn = xs.map(num);
  const yn = ys.map(num);
  if (sameUnit && x.unit !== null) {
    const near = xn.every((v, i) => Math.abs(v - yn[i]!) <= 0.01 * Math.max(Math.abs(v), Math.abs(yn[i]!)));
    if (near)
      return out(
        "NEAR_DUPLICATE_SERIES",
        "The two series are within one percent of each other on every shared day, so they are the same measurement twice.",
      );
  }
  if (sameUnit) {
    const nonneg = xn.every((v) => v >= 0) && yn.every((v) => v >= 0);
    if (nonneg) {
      const yInX = yn.every((v, i) => v <= xn[i]!);
      const xInY = xn.every((v, i) => v <= yn[i]!);
      if (yInX && nameIsPartOf(y, x))
        return out(
          "PART_OF_WHOLE",
          `The outcome series is a part of the predictor series (${y.column} never exceeds ${x.column} and its name says it is a subset), so the two move together by construction.`,
        );
      if (xInY && nameIsPartOf(x, y))
        return out(
          "PART_OF_WHOLE",
          `The predictor series is a part of the outcome series (${x.column} never exceeds ${y.column} and its name says it is a subset), so the two move together by construction.`,
        );
    }
  }
  // a ratio series equal to p / q for two siblings of its own panel
  const pool = siblings.filter((c) => c.panelHash === x.panelHash || c.panelHash === y.panelHash);
  for (const [ratio, other] of [
    [y, x],
    [x, y],
  ] as const) {
    if (!isRatioUnit(ratio.unit)) continue;
    const same = (a: Candidate, b: Candidate): boolean => {
      if (a.panelHash === b.panelHash && a.column === b.column) return true;
      const d = sharedDays(a, b);
      return d.length >= 2 && d.every((k) => a.values.get(k) === b.values.get(k));
    };
    for (const p of pool.filter((c) => c.panelHash === ratio.panelHash && c !== ratio))
      for (const q of pool.filter((c) => c.panelHash === ratio.panelHash && c !== ratio && c !== p)) {
        const dd = [...ratio.values.keys()].filter((k) => p.values.has(k) && q.values.has(k));
        if (dd.length < 2) continue;
        const ok = dd.every((k) => {
          const qv = num(q.values.get(k)!);
          if (qv <= 0) return false;
          const r = num(ratio.values.get(k)!);
          return Math.abs(r - num(p.values.get(k)!) / qv) <= 1e-5 + 1e-3 * Math.abs(r);
        });
        if (!ok) continue;
        if (same(other, p))
          return out(
            "RATIO_OF_PREDICTOR",
            `${ratio.column} is ${p.column} divided by ${q.column} on every day, so ${other.column} is the numerator of the series it is tested against.`,
          );
        if (same(other, q))
          notes.push(
            `${ratio.column} is ${p.column} divided by ${q.column} on every day, so ${other.column} is the denominator of the series it is tested against: a negative association can be built in by arithmetic.`,
          );
      }
  }
  return out(
    "INDEPENDENT",
    "No part-of, duplicate or numerator relation was found between the two series.",
    notes,
  );
}

// ---- plan sentences ----------------------------------------------------------------------------------------------------
const cap = (s: string): string => (s ? `${s[0]!.toUpperCase()}${s.slice(1)}` : s);

/** The testable sentence of a plan, in the direction the plan expects. */
export function statementOf(
  x: { column: string },
  y: { column: string },
  relation: Relation,
  lagDays: number,
  sign: ExpectedSign,
): string {
  const X = humanize(x.column);
  const Y = humanize(y.column);
  if (relation === "leads") {
    const d = lagDays === 1 ? "1 day" : `${lagDays} days`;
    if (sign === "either")
      return `${cap(X)} on a day is systematically related to ${Y} ${d} later, in either direction.`;
    return `Days with higher ${X} are followed ${d} later by ${sign === "positive" ? "higher" : "lower"} ${Y}.`;
  }
  if (sign === "either")
    return `${cap(X)} and ${Y} are systematically related from day to day, in either direction.`;
  return `Days with higher ${X} have ${sign === "positive" ? "higher" : "lower"} ${Y}.`;
}

/** The sign the question asks for, from plain direction words; `either` when it names none. */
export function expectedSignOf(question: string): ExpectedSign {
  const q = ` ${question.toLowerCase()} `;
  const neg = /\b(fewer|less|lower|decreas\w*|drop\w*|fall\w*|reduc\w*|inverse|negative|smaller)\b/.test(q);
  const pos = /\b(more|higher|increas\w*|bigger|larger|positive|busy|busier|busiest)\b/.test(q);
  if (pos && !neg) return "positive";
  if (neg && !pos) return "negative";
  return "either";
}

const planSeries = (c: Candidate): PlanSeries => ({
  panel: c.panelHash,
  panelTitle: c.panelTitle,
  column: c.column,
  label: `${c.panelTitle}: ${c.column}`.slice(0, 200),
});

/** Builds the recorded plan for two chosen candidates. */
export function planFor(
  x: Candidate,
  y: Candidate,
  o: {
    chosenBy: ChosenBy;
    why: string;
    lagDays?: number;
    expectedSign?: ExpectedSign;
    statement?: string;
  },
): TestPlan {
  const lagDays = Math.max(0, Math.min(MAX_LAG_DAYS, Math.floor(o.lagDays ?? 0)));
  const relation: Relation = lagDays > 0 ? "leads" : "moves_with";
  const expectedSign = o.expectedSign ?? "either";
  return {
    x: planSeries(x),
    y: planSeries(y),
    relation,
    lagDays,
    expectedSign,
    statement: (o.statement?.trim() || statementOf(x, y, relation, lagDays, expectedSign)).slice(0, 400),
    chosenBy: o.chosenBy,
    why: o.why.slice(0, 600),
  };
}

// ---- the deterministic chooser -----------------------------------------------------------------------------------------
export interface Chosen {
  x: Candidate;
  y: Candidate;
  why: string;
  expectedSign: ExpectedSign;
}

/**
 * Picks the pair a question asks about, with no model: tokens of the question (stemmed, with a few plain synonyms) are matched
 * against column names (weight 2) and panel titles (weight 1); a pair needs a different matched concept on each side, at
 * least `minDays` shared days, and must not be mechanically related (part of a whole, duplicate, numerator of a ratio) nor
 * one name inside the other. Highest summed score wins, then longer overlap, then panel and column order. The series whose
 * matched word comes later in the question is the outcome (y). Returns null when nothing matches, and the caller then falls
 * back to the old longest-overlap rule (labelled as such).
 */
export function chooseForQuestion(cands: Candidate[], question: string, minDays = 30): Chosen | null {
  const qTok = tokensOf(question).filter((t) => !GENERIC.has(t));
  if (!qTok.length) return null;
  const pos = new Map<string, number>();
  qTok.forEach((t, i) => pos.set(t, i));
  const rawWords = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  rawWords.forEach((w, i) => {
    for (const s of SYNONYMS[w] ?? []) if (!pos.has(stem(s))) pos.set(stem(s), i);
  });
  const qSet = new Set(pos.keys());
  interface Sc {
    c: Candidate;
    i: number;
    colMatch: string[];
    score: number;
    at: number;
  }
  const scored: Sc[] = [];
  cands.forEach((c, i) => {
    const colMatch = [...new Set(concept(c.column).filter((t) => qSet.has(t)))];
    const titleMatch = [...new Set(concept(c.panelTitle).filter((t) => qSet.has(t)))];
    const score = 2 * colMatch.length + titleMatch.length;
    if (!colMatch.length || score === 0) return;
    const at = Math.max(...colMatch.map((t) => pos.get(t)!));
    scored.push({ c, i, colMatch, score, at });
  });
  let best: { a: Sc; b: Sc; total: number; run: number } | null = null;
  for (let p = 0; p < scored.length; p++)
    for (let q = p + 1; q < scored.length; q++) {
      const a = scored[p]!;
      const b = scored[q]!;
      if (a.colMatch.join() === b.colMatch.join()) continue;
      const ca = concept(a.c.column);
      const cb = concept(b.c.column);
      if (ca.every((t) => cb.includes(t)) || cb.every((t) => ca.includes(t))) continue;
      const run = longestShared(a.c, b.c).length;
      if (run < minDays) continue;
      const siblings = cands.filter((c) => c.panelHash === a.c.panelHash || c.panelHash === b.c.panelHash);
      const rel = relatednessOf(a.c, b.c, siblings);
      if (rel.status === "mechanical") continue;
      const total = a.score + b.score;
      if (
        !best ||
        total > best.total ||
        (total === best.total && run > best.run) ||
        (total === best.total && run === best.run && a.i + b.i < best.a.i + best.b.i)
      )
        best = { a, b, total, run };
    }
  if (!best) return null;
  const [first, second] = best.a.at <= best.b.at ? [best.a, best.b] : [best.b, best.a];
  const sign = expectedSignOf(question);
  return {
    x: first.c,
    y: second.c,
    expectedSign: sign,
    why:
      `Chosen by rule from the words of the question: ${first.c.column} matches ${first.colMatch.join(", ")} and ${second.c.column} matches ${second.colMatch.join(", ")}; the series named later in the question is the outcome. ` +
      `Pairs that are part of a whole, duplicates or ratios of each other were skipped.`,
  };
}

// ---- a pair proposed by a model --------------------------------------------------------------------------------------------
export interface PlannerProposal {
  x: TestPair;
  y: TestPair;
  lagDays?: number;
  expectedSign?: ExpectedSign;
  statement?: string;
  why?: string;
}
/** Checks a model's proposal against the real candidates; ids only are trusted, the sentence is limited text. */
export function validateProposal(
  p: PlannerProposal,
  cands: Candidate[],
): { ok: true; x: Candidate; y: Candidate } | { ok: false; reason: string } {
  const find = (t: TestPair): Candidate | undefined =>
    cands.find((c) => c.panelHash === t.panelHash && c.column === t.column);
  const x = find(p.x);
  const y = find(p.y);
  if (!x || !y) return { ok: false, reason: "a proposed series is not among the candidate series" };
  if (x === y) return { ok: false, reason: "the two proposed series are the same series" };
  if (p.lagDays !== undefined && (!Number.isInteger(p.lagDays) || p.lagDays < 0 || p.lagDays > MAX_LAG_DAYS))
    return { ok: false, reason: "the proposed lag is not between 0 and 30 days" };
  if (p.statement !== undefined && (p.statement.length > 300 || /[^\x20-\x7e]/.test(p.statement)))
    return { ok: false, reason: "the proposed sentence is too long or not plain text" };
  if (longestShared(x, y).length < 2)
    return { ok: false, reason: "the proposed series share fewer than two days" };
  const rel = relatednessOf(
    x,
    y,
    cands.filter((c) => c.panelHash === x.panelHash || c.panelHash === y.panelHash),
  );
  if (rel.status === "mechanical") return { ok: false, reason: rel.reason };
  return { ok: true, x, y };
}
