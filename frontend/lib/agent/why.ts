import type { StepRefs, TaskStep } from './thread';

/** "Why this step" and the reasons results carry for their choices. Nothing here invents a reason: no data, no line. */

export const whyLine = (s: Pick<TaskStep, 'why'>): string | null => (s.why ? `Why: ${s.why}` : null);

export const markerReason = (refs: StepRefs, markerId: string): string | null => refs.markerReasons?.find((r) => r.id === markerId)?.reason ?? null;

export function monitorReason(refs: StepRefs, ruleId: string): { reason: string; thresholdFrom: string | null } | null {
  const r = refs.monitorReasons?.find((x) => x.id === ruleId);
  return r ? { reason: r.reason, thresholdFrom: r.thresholdFrom } : null;
}

/** "threshold taken from …", or null. */
export const thresholdFromLine = (from: string | null): string | null => (from ? `threshold taken from ${from}` : null);

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The composer's reason for drawing a panel, matched on the panel's title (case and spacing ignored). */
export function queryNoteFor(refs: StepRefs, panelTitle: string): string | null {
  const t = norm(panelTitle);
  return refs.queryNotes?.find((n) => norm(n.panelTitle) === t)?.why ?? null;
}
