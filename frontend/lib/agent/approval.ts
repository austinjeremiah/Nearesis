import type { ConsentRequirement, Task } from './thread';
import { formatUsdString } from './tasks';

/**
 * Pure rules for "the agent needs you to decide": a proposed plan (tick the consents, press Start) or a running task
 * that is waiting for a run approval (Approve or Reject). The plan card, the top status strip and the storyboard header
 * all read this one function so they can never disagree.
 */

export type Approval =
  | { kind: 'plan'; taskId: string; consents: number; missing: number; firstMissingKey: string | null; notice: string; line: string }
  | { kind: 'run'; taskId: string; stepIdx: number; summary: string; notice: string; line: string };

export const APPROVAL_NOTICE = 'Waiting for your approval';
export const APPROVAL_BUTTON = 'Review and start';
export const RUN_APPROVAL_BUTTON = 'Review and decide';
export const PLAN_LINE_CONSENT = 'Tick each box to allow it, then press Start. Nothing runs before that.';
export const PLAN_LINE_NONE = 'Nothing here spends credits or publishes. Press Start to run it.';
export const RUN_LINE = 'The agent is waiting for you. Approve or reject to continue.';

/** What the user must do for this task, or null when nothing waits on them. `ticked` is the plan card's local ticks. */
export function approvalNeeded(task: Task | null | undefined, ticked: ReadonlySet<string> = new Set()): Approval | null {
  if (!task) return null;
  if (task.state === 'proposed') {
    const missingList = task.consent.required.filter((c) => !ticked.has(c.key));
    return {
      kind: 'plan',
      taskId: task.id,
      consents: task.consent.required.length,
      missing: missingList.length,
      firstMissingKey: missingList[0]?.key ?? null,
      notice: APPROVAL_NOTICE,
      line: task.consent.required.length > 0 ? PLAN_LINE_CONSENT : PLAN_LINE_NONE,
    };
  }
  if (task.state === 'waiting_user') {
    const s = task.steps.find((x) => x.state === 'waiting_user' && x.waiting);
    if (!s) return null;
    return { kind: 'run', taskId: task.id, stepIdx: s.idx, summary: s.waiting?.summary || s.title, notice: 'The agent is waiting for you', line: RUN_LINE };
  }
  return null;
}

/** What one consent box allows and its limit, in plain words. The server label stays as the box's own title. */
export function consentAllowance(c: Pick<ConsentRequirement, 'key' | 'maxUsd'>): string {
  switch (c.key) {
    case 'spend_credits':
      return c.maxUsd !== null ? `Spend up to ${formatUsdString(c.maxUsd)} of your credits` : 'Spend credits (no limit was stated)';
    case 'publish_public':
      return 'Publish publicly';
    case 'freeze_hypothesis':
      return 'Freeze the hypothesis so it cannot be edited';
    case 'archive_workspace':
      return 'Archive the workspace';
  }
}

/** Screen-reader sentence for the live region when approval is needed. */
export function approvalAnnouncement(a: Approval | null): string {
  if (!a) return '';
  if (a.kind === 'run') return `The agent is waiting for you. ${a.summary}. Approve or reject to continue.`;
  return a.consents > 0 ? `Waiting for your approval. ${a.consents} permission${a.consents === 1 ? '' : 's'} to tick, then press Start.` : 'Waiting for your approval. Press Start to run the plan.';
}
