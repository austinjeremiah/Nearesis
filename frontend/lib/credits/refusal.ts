import { CONTACT_EMAIL, allowanceLabel, isUsd } from './usd';

/**
 * App-wide "You have used your credits" popup state, a tiny external store (no React needed here, so the central API
 * transport can feed it). One popup is mounted in the app frame and reads this.
 *
 * Opening rules:
 *  - a refusal caused by a user action (any non-GET request) always opens it, even after a dismissal: that is a NEW event;
 *  - a refusal seen while polling (GET), and the "exhausted on load" check, open it only if it has never been dismissed,
 *    so closing it keeps it closed while polls keep failing.
 */

export const REFUSAL_REASONS = ['CREDITS_EXHAUSTED', 'GLOBAL_CEILING'] as const;

export type RefusalInfo = {
  reasonCode: string;
  allowanceUsd: string | null;
  availableUsd: string | null;
  contactEmail: string;
};

export type RefusalState = { open: boolean; info: RefusalInfo | null; dismissed: boolean };

let state: RefusalState = { open: false, info: null, dismissed: false };
const listeners = new Set<() => void>();

function set(next: RefusalState) {
  state = next;
  listeners.forEach((l) => l());
}

export const subscribeRefusal = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const getRefusalState = (): RefusalState => state;

/** Test hook: back to the initial state. */
export function resetRefusal() {
  set({ open: false, info: null, dismissed: false });
}

export function isRefusalReason(reasonCode: unknown): boolean {
  return typeof reasonCode === 'string' && (REFUSAL_REASONS as readonly string[]).includes(reasonCode);
}

/** Pull what the popup shows out of a refusal body (`details` is an object for CREDITS_EXHAUSTED). */
export function refusalInfo(body: unknown): RefusalInfo | null {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (!b || !isRefusalReason(b.reasonCode)) return null;
  const d = b.details && typeof b.details === 'object' && !Array.isArray(b.details) ? (b.details as Record<string, unknown>) : {};
  const usd = (v: unknown) => (isUsd(v) ? v : null);
  return {
    reasonCode: b.reasonCode as string,
    allowanceUsd: usd(d.allowanceUsd),
    availableUsd: usd(d.availableUsd),
    contactEmail: typeof d.contactEmail === 'string' && d.contactEmail ? d.contactEmail : CONTACT_EMAIL,
  };
}

/** A refusal arrived. `userAction` is true for writes the person just triggered. Returns whether the popup is now open. */
export function reportRefusal(info: RefusalInfo, opts: { userAction: boolean }): boolean {
  if (state.open) {
    // Already showing: only refresh the figures.
    set({ ...state, info: { ...info, allowanceUsd: info.allowanceUsd ?? state.info?.allowanceUsd ?? null } });
    return true;
  }
  if (!opts.userAction && state.dismissed) return false;
  set({ open: true, info, dismissed: opts.userAction ? false : state.dismissed });
  return true;
}

/** Open from a button the person pressed (for example on a failed step). */
export function openCreditsPopup(info?: Partial<RefusalInfo>) {
  reportRefusal({ reasonCode: 'CREDITS_EXHAUSTED', allowanceUsd: null, availableUsd: null, contactEmail: CONTACT_EMAIL, ...info }, { userAction: true });
}

/** The exhausted state seen on load (GET /v1/credits says exhausted): opens once, never again after a dismissal. */
export function reportExhaustedOnLoad(info: Partial<RefusalInfo>): boolean {
  return reportRefusal({ reasonCode: 'CREDITS_EXHAUSTED', allowanceUsd: null, availableUsd: null, contactEmail: CONTACT_EMAIL, ...info }, { userAction: false });
}

export function dismissRefusal() {
  set({ ...state, open: false, dismissed: true });
}

/** "You have used your USD 3 of credits." when the allowance is known, else the plain sentence. */
export function refusalText(info: Pick<RefusalInfo, 'allowanceUsd' | 'contactEmail'> | null): string {
  const a = allowanceLabel(info?.allowanceUsd ?? null);
  const mail = info?.contactEmail ?? CONTACT_EMAIL;
  return `${a ? `You have used your USD ${a} of credits.` : 'You have used your credits.'} Write to ${mail} to request more access.`;
}

/** mailto link with a prefilled request line and who is asking. */
export function mailtoHref(args: { email?: string; allowanceUsd?: string | null; accountId?: string | null; displayName?: string | null; nearAccountId?: string | null }): string {
  const email = args.email ?? CONTACT_EMAIL;
  const a = allowanceLabel(args.allowanceUsd ?? null);
  const who = [
    `Account: ${args.accountId ?? 'unknown'}${args.displayName ? ` (${args.displayName})` : ''}`,
    `NEAR account: ${args.nearAccountId ?? 'none linked'}`,
  ];
  const body = [
    'Hello,',
    '',
    `I have used ${a ? `my USD ${a} of` : 'my'} Nearesis credits and would like to request more access.`,
    '',
    ...who,
    '',
  ].join('\n');
  return `mailto:${email}?subject=${encodeURIComponent('Request for more Nearesis credits')}&body=${encodeURIComponent(body)}`;
}
