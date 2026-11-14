import { canonicalJson, concept, sha256Hex } from "@nearesis/capsule";
import { wordingFailures } from "../user-thesis/validate.ts";

/**
 * The TEST PLAN of an agent task: the claim, written before the data is seen. The planner proposes it in the same call as the
 * plan; the user may edit it while the task is `proposed`; Start locks it (time and sha256 of the canonical fields) and a
 * locked plan never changes. Everything here is pure: model output is untrusted and is sanitised here, never trusted.
 */
export type Relation = "moves_with" | "leads";
export type ExpectedSign = "positive" | "negative" | "either";

/** The fields a plan carries. `statement: null` means no plan was written (the card asks the user to write it). */
export interface TestPlanFields {
  statement: string | null;
  xLabel: string | null;
  yLabel: string | null;
  relation: Relation;
  lagDays: number;
  expectedSign: ExpectedSign;
  windowDays: number;
  wouldCountAsWrong: string | null;
}
/** What the task view and the database hold. */
export interface TaskTestPlan extends TestPlanFields {
  editedByUser: boolean;
  lockedAt: string | null;
  sha256: string | null;
}
export interface PlanIssue {
  path: string;
  issue: string;
}

export const STATEMENT_MAX = 200;
export const LABEL_MAX = 60;
export const WRONG_MAX = 240;
export const WINDOW_MIN = 30;
export const WINDOW_MAX = 365;
export const LAG_MAX = 30;
export const DEFAULT_WINDOW_DAYS = 90;

/** A plan with nothing written: what a task gets when the planner returns none or it fails validation. */
export const emptyPlan = (): TaskTestPlan => ({
  statement: null,
  xLabel: null,
  yLabel: null,
  relation: "moves_with",
  lagDays: 0,
  expectedSign: "either",
  windowDays: DEFAULT_WINDOW_DAYS,
  wouldCountAsWrong: null,
  editedByUser: false,
  lockedAt: null,
  sha256: null,
});

/** The canonical fields the lock hashes (never the edit flag or the lock time). */
export const canonicalFieldsOf = (p: TestPlanFields): Record<string, unknown> => ({
  statement: p.statement,
  xLabel: p.xLabel,
  yLabel: p.yLabel,
  relation: p.relation,
  lagDays: p.lagDays,
  expectedSign: p.expectedSign,
  windowDays: p.windowDays,
  wouldCountAsWrong: p.wouldCountAsWrong,
});
export const testPlanSha = (p: TestPlanFields): string => sha256Hex(canonicalJson(canonicalFieldsOf(p)));

/** A plan that names something to test (statement and both labels). */
export const isWritten = (
  p: TaskTestPlan | null | undefined,
): p is TaskTestPlan & {
  statement: string;
  xLabel: string;
  yLabel: string;
  wouldCountAsWrong: string;
} => Boolean(p && p.statement && p.xLabel && p.yLabel && p.wouldCountAsWrong);

const PLAIN = /^[\x20-\x7e]+$/;
/** Words that claim cause, on top of the thesis validator's list (a plan states an association between two series). */
const CAUSAL_EXTRA =
  /\b(cause[sd]?|causing|causal|drive[sn]?|drove|driving|leads? to|led to|because of|due to|results? in|resulted in|triggers?|triggered|boosts?|effect of|impact of|bullish|bearish)\b/i;
/** Wording of one text: the thesis validator (causal, bullish, significance wording) plus the extra causal words. */
const badWording = (text: string, where: string): boolean =>
  wordingFailures(text, where).length > 0 || CAUSAL_EXTRA.test(text);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Digit runs of a text. */
const digitRuns = (s: string): string[] => s.match(/\d+/g) ?? [];

function textIssues(
  path: string,
  value: unknown,
  max: number,
  allowedDigits: Set<string>,
  words: boolean,
): { text: string } | { issue: string } {
  if (value === null || value === undefined) return { issue: "is required" };
  if (typeof value !== "string") return { issue: "must be text" };
  const t = oneLine(value);
  if (!t) return { issue: "must not be empty" };
  if (t.length > max) return { issue: `must be at most ${max} characters` };
  if (!PLAIN.test(t))
    return { issue: "must be plain text (letters, digits and punctuation, no special characters)" };
  const bad = digitRuns(t).find((d) => !allowedDigits.has(d));
  if (bad !== undefined)
    return {
      issue: "must not contain numbers (the lag and the window have their own fields)",
    };
  if (words && badWording(t, path)) return { issue: "must not use causal, bullish or significance wording" };
  return { text: t };
}

/** Same series if the plain concept words of the two labels are the same. */
const sameSeries = (a: string, b: string): boolean => {
  const ca = [...new Set(concept(a))].sort().join(" ");
  const cb = [...new Set(concept(b))].sort().join(" ");
  return a.trim().toLowerCase() === b.trim().toLowerCase() || (ca !== "" && ca === cb);
};

const SIGNS = new Set(["positive", "negative", "either"]);
const RELATIONS = new Set(["moves_with", "leads"]);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Validates a COMPLETE set of plan fields. `coerce` is for the planner (relation follows the lag, sentences are never rewritten);
 * a user's edit is not coerced and gets a field-level issue instead.
 */
export function sanitizePlan(
  raw: Record<string, unknown>,
  o: { coerce: boolean },
): { ok: true; plan: TestPlanFields } | { ok: false; issues: PlanIssue[] } {
  const issues: PlanIssue[] = [];
  const bad = (path: string, issue: string): void => void issues.push({ path, issue });

  let lagDays = raw.lagDays;
  let windowDays = raw.windowDays;
  if (!isInt(lagDays) || lagDays < 0 || lagDays > LAG_MAX) {
    bad("lagDays", `must be a whole number from 0 to ${LAG_MAX}`);
    lagDays = 0;
  }
  if (!isInt(windowDays) || windowDays < WINDOW_MIN || windowDays > WINDOW_MAX) {
    bad("windowDays", `must be a whole number from ${WINDOW_MIN} to ${WINDOW_MAX}`);
    windowDays = DEFAULT_WINDOW_DAYS;
  }
  let relation = raw.relation;
  if (typeof relation !== "string" || !RELATIONS.has(relation)) {
    bad("relation", "must be moves_with or leads");
    relation = "moves_with";
  }
  const lag = lagDays as number;
  if (o.coerce) relation = lag > 0 ? "leads" : "moves_with";
  else if (relation === "moves_with" && lag > 0)
    bad("lagDays", "must be 0 when the series move together on the same day");
  else if (relation === "leads" && lag === 0)
    bad("lagDays", "must be at least 1 when the first series leads");
  if (typeof raw.expectedSign !== "string" || !SIGNS.has(raw.expectedSign))
    bad("expectedSign", "must be positive, negative or either");

  const allowed = new Set([String(lag), String(windowDays)]);
  const field = (
    path: "statement" | "xLabel" | "yLabel" | "wouldCountAsWrong",
    max: number,
    words: boolean,
  ): string => {
    const r = textIssues(path, raw[path], max, allowed, words);
    if ("issue" in r) {
      bad(path, r.issue);
      return "";
    }
    return r.text;
  };
  const statement = field("statement", STATEMENT_MAX, true);
  const xLabel = field("xLabel", LABEL_MAX, true);
  const yLabel = field("yLabel", LABEL_MAX, true);
  const wouldCountAsWrong = field("wouldCountAsWrong", WRONG_MAX, true);
  if (xLabel && yLabel && sameSeries(xLabel, yLabel))
    bad("yLabel", "must name a different series than xLabel");
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    plan: {
      statement,
      xLabel,
      yLabel,
      relation: relation as Relation,
      lagDays: lag,
      expectedSign: raw.expectedSign as ExpectedSign,
      windowDays: windowDays as number,
      wouldCountAsWrong,
    },
  };
}

/** The planner's plan: sanitised, or the empty plan (statement null) when anything fails. */
export function planFromPlanner(raw: Record<string, unknown> | null | undefined): TaskTestPlan {
  if (!raw || typeof raw.statement !== "string" || !raw.statement.trim()) return emptyPlan();
  const r = sanitizePlan(raw, { coerce: true });
  return r.ok ? { ...r.plan, editedByUser: false, lockedAt: null, sha256: null } : emptyPlan();
}

export type PlanPatch = Partial<Record<keyof TestPlanFields, unknown>>;
const PATCH_KEYS = [
  "statement",
  "xLabel",
  "yLabel",
  "relation",
  "lagDays",
  "expectedSign",
  "windowDays",
  "wouldCountAsWrong",
] as const;
export const PATCH_FIELDS: readonly string[] = PATCH_KEYS;

/** Applies a user's edit to an unlocked plan: unknown fields and any invalid value are field-level issues. */
export function applyPatch(
  current: TaskTestPlan,
  patch: Record<string, unknown>,
): { ok: true; plan: TaskTestPlan } | { ok: false; issues: PlanIssue[] } {
  const issues: PlanIssue[] = [];
  for (const k of Object.keys(patch))
    if (!PATCH_FIELDS.includes(k)) issues.push({ path: k, issue: "is not a test plan field" });
  if (!Object.keys(patch).length) issues.push({ path: "testPlan", issue: "has nothing to change" });
  if (issues.length) return { ok: false, issues };
  const merged: Record<string, unknown> = { ...canonicalFieldsOf(current), ...patch };
  // clearing the statement clears the plan: the thesis then says the pair was chosen by rule
  if (merged.statement === null) {
    const e = emptyPlan();
    return { ok: true, plan: { ...e, windowDays: current.windowDays, editedByUser: true } };
  }
  const r = sanitizePlan(merged, { coerce: false });
  if (!r.ok) return { ok: false, issues: r.issues };
  return { ok: true, plan: { ...r.plan, editedByUser: true, lockedAt: null, sha256: null } };
}

/** Start locks a written plan: the time and the hash of its canonical fields. A plan with no statement has nothing to lock. */
export function lockPlan(p: TaskTestPlan, at: Date): TaskTestPlan {
  if (!isWritten(p)) return p;
  return { ...p, lockedAt: at.toISOString(), sha256: testPlanSha(p) };
}

/**
 * The plain instruction that follows the question, so the investigation charts exactly the two series of the plan over the
 * same days, one chart each or one shared chart.
 */
export function instructionFor(p: { xLabel: string; yLabel: string; windowDays: number }): string {
  return (
    `Test plan for this investigation: chart exactly these two daily series over the same last ${p.windowDays} days, ` +
    `one chart each or one shared chart, so that both exist as panels: "${p.xLabel}" and "${p.yLabel}". ` +
    `Give each its own column, a daily value for every day of the window.`
  );
}
/** The question as sent to the investigation: the user's words, then the instruction (the whole text stays within 2000 chars). */
export function questionWithPlan(
  question: string,
  p: { xLabel: string; yLabel: string; windowDays: number },
): string {
  const instruction = instructionFor(p);
  const room = 2000 - instruction.length - 2;
  return `${question.trim().slice(0, Math.max(0, room))}\n\n${instruction}`;
}

// ------------------------------------------------------------------------------------------------------------ why a step
/** One fixed sentence per step key: the fallback when the planner gave none, or one that did not validate. */
export const FALLBACK_WHY: Record<string, string> = {
  "workspace.create":
    "A workspace keeps this investigation, its charts and its thesis together in one place.",
  "workspace.use":
    "The request is about a workspace you already have, so the work stays with its earlier runs and theses.",
  "workspace.archive": "You asked to archive the workspace; it is hidden from the list, not deleted.",
  "question.ask": "The investigation reads the data and draws the charts that every later step builds on.",
  "run.await":
    "The later steps need the finished run, so the agent waits for it and approves only the free canvas patch.",
  "setup.auto":
    "Markers, monitors and a draft hypothesis turn the run's findings into things you can follow up on.",
  "marker.create": "You gave the panel and the time, so the marker records exactly that point.",
  "monitor.create": "You gave the source and the metric, so the rule watches exactly that value.",
  "hypothesis.create": "You gave the proposition, so it is recorded as a draft before anything is frozen.",
  "hypothesis.freeze": "You asked to freeze the hypothesis, which fixes it so it cannot be edited later.",
  "capsule.build":
    "The capsule freezes the run's data and checks, so the thesis can be verified and rerun later.",
  "capsule.prove": "You asked for an independent proof of the capsule on OutLayer.",
  "capsule.publish": "You asked to publish the capsule, which gives it a public page.",
  "report.build": "You asked for the older workspace summary, so it is checked and linked.",
  "thesis.build":
    "The thesis is the report: it tests the relationship you asked about and states its verdict.",
  "thesis.publish": "You asked to share the thesis, so it gets a public link that you can remove later.",
  "thesis.compare":
    "A reproduction is only useful next to the original, so the two are compared value by value.",
  "thesis.challenge":
    "A skeptic looks for what the thesis overlooks; the challenge is stored beside it and never edits it.",
};
export const fallbackWhy = (key: string): string =>
  FALLBACK_WHY[key] ?? "This step is part of the plan you asked for.";

export const WHY_MAX = 220;
/** The planner's one-line reason for a step: plain text, no numbers except those in the step's own params, wording validator. */
export function sanitizeWhy(raw: unknown, params: Record<string, unknown>): string | null {
  if (typeof raw !== "string") return null;
  const t = oneLine(raw);
  if (!t || t.length > WHY_MAX || !PLAIN.test(t)) return null;
  const own = new Set(digitRuns(JSON.stringify(params)));
  if (digitRuns(t).some((d) => !own.has(d))) return null;
  if (badWording(t, "why")) return null;
  return t;
}
