/**
 * Challenges: a skeptic model reads a thesis once and says where it is weak. A challenge never changes the thesis. This
 * is the tolerant reader plus the pure presentation rules (outcome tone, grouping, the dropped-notes sentence).
 */

export type Outcome = 'holds' | 'weakened' | 'unsupported' | 'unavailable';
export type Group = 'coverage' | 'window' | 'measurement' | 'causation' | 'alternative';
export type Severity = 'minor' | 'material';
export type Note = { text: string; group: Group | null; severity: Severity | null; refs: string[] };
export type ChallengeAnswer = { text: string; by: string | null; at: string | null };
export type Challenge = {
  id: string;
  outcome: Outcome;
  notes: Note[];
  droppedNotes: number | null;
  cost: { usd: string | null; modelCalls: number | null };
  by: string | null;
  createdAt: string | null;
  answer: ChallengeAnswer | null;
};

type R = Record<string, unknown>;
const isRec = (v: unknown): v is R => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const usd = (v: unknown): string | null => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? v : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : null);

export const OUTCOMES: readonly Outcome[] = ['holds', 'weakened', 'unsupported', 'unavailable'];
export const GROUPS: readonly Group[] = ['coverage', 'window', 'measurement', 'causation', 'alternative'];

export const OUTCOME_TONE: Record<Outcome, 'ok' | 'warn' | 'bad' | ''> = { holds: 'ok', weakened: 'warn', unsupported: 'bad', unavailable: '' };
export const OUTCOME_WORD: Record<Outcome, string> = { holds: 'holds', weakened: 'weakened', unsupported: 'unsupported', unavailable: 'unavailable' };
export const GROUP_LABEL: Record<Group, string> = { coverage: 'Coverage', window: 'Window', measurement: 'Measurement', causation: 'Causation', alternative: 'Alternative explanations' };
export const SEVERITY_TONE: Record<Severity, 'warn' | ''> = { material: 'warn', minor: '' };

export function normalizeChallenge(raw: unknown): Challenge | null {
  if (!isRec(raw)) return null;
  const id = str(raw.challengeId) ?? str(raw.id);
  if (!id) return null;
  const cost = isRec(raw.cost) ? raw.cost : {};
  const a = raw.answer;
  const answer: ChallengeAnswer | null = typeof a === 'string' ? (str(a) ? { text: a, by: null, at: null } : null) : isRec(a) && str(a.text) ? { text: str(a.text)!, by: str(a.by), at: str(a.at) ?? str(a.createdAt) } : null;
  return {
    id,
    outcome: OUTCOMES.find((o) => o === raw.outcome) ?? 'unavailable',
    notes: (Array.isArray(raw.notes) ? raw.notes : []).flatMap((n) =>
      isRec(n) && str(n.text)
        ? [{ text: str(n.text)!, group: GROUPS.find((g) => g === n.group) ?? null, severity: n.severity === 'material' || n.severity === 'minor' ? n.severity : null, refs: (Array.isArray(n.refs) ? n.refs : []).filter((x): x is string => typeof x === 'string') } satisfies Note]
        : [],
    ),
    droppedNotes: num(raw.droppedNotes),
    cost: { usd: usd(cost.usd), modelCalls: num(cost.modelCalls) },
    by: str(raw.by),
    createdAt: str(raw.createdAt),
    answer,
  };
}

/** Newest first, at most ten (the API's own bound), unreadable rows dropped. Anything that is not a list is no challenges. */
export function normalizeChallenges(raw: unknown): Challenge[] {
  const list = (Array.isArray(raw) ? raw : []).map(normalizeChallenge).filter((c): c is Challenge => c !== null);
  return list.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, 10);
}

export type NoteGroup = { group: Group | null; label: string; notes: Note[] };

/** Notes grouped in the contract's fixed group order, material notes first inside a group; notes with no group come last. */
export function groupNotes(notes: Note[]): NoteGroup[] {
  const rank = (n: Note) => (n.severity === 'material' ? 0 : 1);
  const sorted = (xs: Note[]) => xs.map((n, i) => ({ n, i })).sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i).map((x) => x.n);
  const out: NoteGroup[] = [];
  for (const g of GROUPS) {
    const ns = notes.filter((n) => n.group === g);
    if (ns.length) out.push({ group: g, label: GROUP_LABEL[g], notes: sorted(ns) });
  }
  const rest = notes.filter((n) => n.group === null);
  if (rest.length) out.push({ group: null, label: 'Other', notes: sorted(rest) });
  return out;
}

/** "3 notes were dropped because they cited numbers not in the thesis", or null when none were. */
export function droppedText(n: number | null): string | null {
  if (!n || n < 1) return null;
  return `${n} ${n === 1 ? 'note was' : 'notes were'} dropped because ${n === 1 ? 'it' : 'they'} cited numbers not in the thesis.`;
}

export const CHALLENGE_CONFIRM = 'Runs the skeptic against this thesis. Uses your credits (a fraction of a cent). The thesis itself is not changed.';
export const ANSWER_MAX = 600;

/** A challenge needs an answer when it found material notes and the owner has not answered yet. */
export const needsAnswer = (c: Challenge): boolean => !c.answer && c.notes.some((n) => n.severity === 'material');
