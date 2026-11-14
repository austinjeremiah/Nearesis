/**
 * Follow-ups from a finding: three ready-to-send messages that go into the composer (never sent for the user). The
 * wording is the contract's, so the planner recognises it as a follow-up to the workspace's last run.
 */

export type FollowUpKind = 'dig' | 'opposite' | 'extend';

export const FOLLOW_UP_LABEL: Record<FollowUpKind, string> = { dig: 'Dig into this', opposite: 'Check the opposite', extend: 'Extend the window' };
export const FOLLOW_UP_HINT: Record<FollowUpKind, string> = {
  dig: 'Fills the message box with a question about what happened around the dates in this finding. Nothing is sent.',
  opposite: 'Fills the message box with a request to look for evidence against this finding. Nothing is sent.',
  extend: 'Fills the message box with a request to repeat this over the last 365 days. Nothing is sent.',
};

/** The composer takes 2000 characters; the statement is cut (with an ellipsis) so the whole message always fits. */
export const COMPOSER_MAX = 2000;

const MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const DATE_RES = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+\\d{4}\\b`, 'gi'),
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi'),
];

/** The dates a finding names, as written, in order of appearance, without repeats. At most three. */
export function extractDates(statement: string): string[] {
  const hits: { at: number; text: string }[] = [];
  for (const re of DATE_RES) for (const m of statement.matchAll(re)) hits.push({ at: m.index ?? 0, text: m[0] });
  hits.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    const k = h.text.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(h.text);
    }
  }
  return out.slice(0, 3);
}

export const joinDates = (d: string[]): string => (d.length <= 1 ? (d[0] ?? '') : `${d.slice(0, -1).join(', ')} and ${d[d.length - 1]}`);

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function fit(prefix: string, statement: string): string {
  const room = COMPOSER_MAX - prefix.length;
  const st = clean(statement);
  return prefix + (st.length > room ? `${st.slice(0, Math.max(0, room - 1)).trimEnd()}…` : st);
}

/** The message that goes into the composer. `statement` is the finding's text. */
export function followUpMessage(kind: FollowUpKind, statement: string): string {
  const st = clean(statement);
  switch (kind) {
    case 'dig': {
      const dates = extractDates(st);
      return fit(`In this workspace, investigate what happened${dates.length ? ` around ${joinDates(dates)}` : ''}: `, st);
    }
    case 'opposite':
      return fit('In this workspace, look for evidence against: ', st);
    case 'extend':
      return fit('In this workspace, repeat this over the last 365 days: ', st);
  }
}

/** For a quick answer with no workspace: the create-and-investigate wording. */
export function createAndDigMessage(statement: string, objective?: string | null): string {
  const base = clean(objective && objective.trim() ? objective : statement).replace(/[.\s]+$/, '');
  const head = 'Create a workspace for this: ';
  const tail = '. Investigate it and build the thesis.';
  const room = COMPOSER_MAX - head.length - tail.length;
  return `${head}${base.length > room ? `${base.slice(0, room - 1).trimEnd()}…` : base}${tail}`;
}

/** The Agent page URL that opens a fresh thread bound to a workspace with the text in the composer. */
export function agentFollowUpHref(workspaceId: string, text: string): string {
  return `/agent?w=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(text)}`;
}

/** A workspace id from the URL is used only when it has the shape of an id; anything else is ignored. */
export function safeWorkspaceParam(v: string | string[] | undefined | null): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

/** Which thesis claims are findings the user can follow up: observed facts and findings, not hypotheses, interpretations or chart labels. */
export function isFindingClaim(kind: string | null | undefined, statement: string): boolean {
  if (!/observed|finding/i.test(kind ?? '')) return false;
  return !/^observed:/i.test(statement.trim());
}
