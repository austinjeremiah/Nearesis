/**
 * The test plan: the one sentence the investigation will be judged against, put on record before any data is seen.
 * Tolerant reader and the pure rules of the editor. A missing field stays unknown (null); nothing is guessed.
 */

export type Relation = 'moves_with' | 'leads';
export type ExpectedSign = 'positive' | 'negative' | 'either';

export type TestPlan = {
  /** One testable sentence about two daily series; null when the planner returned none (the user is asked to write it). */
  statement: string | null;
  xLabel: string | null;
  yLabel: string | null;
  relation: Relation | null;
  lagDays: number | null;
  expectedSign: ExpectedSign | null;
  windowDays: number | null;
  wouldCountAsWrong: string | null;
  editedByUser: boolean;
  lockedAt: string | null;
  sha256: string | null;
};

type R = Record<string, unknown>;
const obj = (v: unknown): R | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as R) : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : null);

export const EDITABLE = ['statement', 'xLabel', 'yLabel', 'relation', 'lagDays', 'expectedSign', 'windowDays', 'wouldCountAsWrong'] as const;
export type EditableKey = (typeof EDITABLE)[number];

/** Null when the task has no test plan object at all (the block is then hidden, not mocked). */
export function normalizeTestPlan(raw: unknown): TestPlan | null {
  const r = obj(raw);
  if (!r) return null;
  const relation = r.relation === 'moves_with' || r.relation === 'leads' ? r.relation : null;
  const sign = r.expectedSign === 'positive' || r.expectedSign === 'negative' || r.expectedSign === 'either' ? r.expectedSign : null;
  return {
    statement: text(r.statement),
    xLabel: text(r.xLabel),
    yLabel: text(r.yLabel),
    relation,
    lagDays: int(r.lagDays),
    expectedSign: sign,
    windowDays: int(r.windowDays),
    wouldCountAsWrong: text(r.wouldCountAsWrong),
    editedByUser: r.editedByUser === true,
    lockedAt: text(r.lockedAt),
    sha256: text(r.sha256),
  };
}

export const SIGN_LABEL: Record<ExpectedSign, string> = { positive: 'positive', negative: 'negative', either: 'either direction' };

/** "moves with" or "leads by 3 days"; unknown when the plan does not say. */
export function relationText(p: Pick<TestPlan, 'relation' | 'lagDays'>): string {
  if (p.relation === 'moves_with') return 'moves with';
  if (p.relation === 'leads') return p.lagDays === null ? 'leads by an unknown number of days' : `leads by ${p.lagDays} ${p.lagDays === 1 ? 'day' : 'days'}`;
  return 'unknown';
}

export const signText = (s: ExpectedSign | null): string => (s ? SIGN_LABEL[s] : 'unknown');
export const windowText = (d: number | null): string => (d === null ? 'unknown' : `${d} ${d === 1 ? 'day' : 'days'}`);

/** First 12 characters of the fingerprint, or null when none was recorded. */
export const shortFingerprint = (sha: string | null): string | null => (sha ? sha.slice(0, 12) : null);

export const isLocked = (p: Pick<TestPlan, 'lockedAt'> | null | undefined): boolean => !!p?.lockedAt;

export const LIMITS = { statement: 200, label: 60, wrong: 240, lagMax: 30, windowMin: 30, windowMax: 365 } as const;

/** The editor's working copy: every field as the text the inputs hold. */
export type Draft = Record<EditableKey, string>;

export function toDraft(p: TestPlan): Draft {
  return {
    statement: p.statement ?? '',
    xLabel: p.xLabel ?? '',
    yLabel: p.yLabel ?? '',
    relation: p.relation ?? '',
    lagDays: p.lagDays === null ? '' : String(p.lagDays),
    expectedSign: p.expectedSign ?? '',
    windowDays: p.windowDays === null ? '' : String(p.windowDays),
    wouldCountAsWrong: p.wouldCountAsWrong ?? '',
  };
}

export type PatchBody = Partial<{ statement: string; xLabel: string; yLabel: string; relation: Relation; lagDays: number; expectedSign: ExpectedSign; windowDays: number; wouldCountAsWrong: string }>;

/** Only the fields the user changed, typed for the wire. A field the user emptied is not sent (the server keeps its value). */
export function diffDraft(p: TestPlan, d: Draft): PatchBody {
  const before = toDraft(p);
  const out: PatchBody = {};
  for (const k of ['statement', 'xLabel', 'yLabel', 'wouldCountAsWrong'] as const) {
    const v = d[k].trim();
    if (v !== before[k] && v !== '') out[k] = v;
  }
  if (d.relation !== before.relation && (d.relation === 'moves_with' || d.relation === 'leads')) out.relation = d.relation;
  if (d.expectedSign !== before.expectedSign && (d.expectedSign === 'positive' || d.expectedSign === 'negative' || d.expectedSign === 'either')) out.expectedSign = d.expectedSign;
  for (const k of ['lagDays', 'windowDays'] as const) {
    if (d[k].trim() !== before[k] && /^\d+$/.test(d[k].trim())) out[k] = Number(d[k].trim());
  }
  return out;
}

/** Client-side limits, so an obvious mistake is said before the request; the server stays the judge. */
export function draftErrors(d: Draft): Partial<Record<EditableKey, string>> {
  const e: Partial<Record<EditableKey, string>> = {};
  if (d.statement.length > LIMITS.statement) e.statement = `At most ${LIMITS.statement} characters.`;
  if (/\d/.test(d.statement)) e.statement = 'Leave numbers out of the sentence; the lag and window have their own fields.';
  if (d.xLabel.length > LIMITS.label) e.xLabel = `At most ${LIMITS.label} characters.`;
  if (d.yLabel.length > LIMITS.label) e.yLabel = `At most ${LIMITS.label} characters.`;
  if (d.wouldCountAsWrong.length > LIMITS.wrong) e.wouldCountAsWrong = `At most ${LIMITS.wrong} characters.`;
  if (d.lagDays.trim() && !(/^\d+$/.test(d.lagDays.trim()) && Number(d.lagDays) <= LIMITS.lagMax)) e.lagDays = `A whole number from 0 to ${LIMITS.lagMax}.`;
  if (d.windowDays.trim() && !(/^\d+$/.test(d.windowDays.trim()) && Number(d.windowDays) >= LIMITS.windowMin && Number(d.windowDays) <= LIMITS.windowMax)) e.windowDays = `A whole number from ${LIMITS.windowMin} to ${LIMITS.windowMax}.`;
  return e;
}

/** Field errors from a 422: each `{path, issue}` whose last path segment is an editable field. */
export function fieldErrorsFrom(details: { path: string; issue: string }[]): Partial<Record<EditableKey, string>> {
  const out: Partial<Record<EditableKey, string>> = {};
  for (const d of details) {
    const key = d.path.split(/[./[\]]+/).filter(Boolean).pop();
    if (key && (EDITABLE as readonly string[]).includes(key)) out[key as EditableKey] = d.issue;
  }
  return out;
}

export type ChosenBy = 'user' | 'planner' | 'rule';
export const CHOSEN_BY_LABEL: Record<ChosenBy, string> = { user: 'you', planner: 'the planner', rule: 'a rule, not named in advance' };

export const NO_STATEMENT_NOTE = 'If you leave it empty, the thesis will say the pair was chosen by rule, not named in advance.';
export const LOCK_NOTE = 'Locked when you press Start. It goes on record before any data is seen.';
