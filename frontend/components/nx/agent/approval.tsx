'use client';

import { useEffect, useState, type RefObject } from 'react';
import { BellRing } from 'lucide-react';
import { APPROVAL_BUTTON, RUN_APPROVAL_BUTTON, type Approval } from '@/lib/agent/approval';

const visible = (el: Element) => el.getClientRects().length > 0;

/**
 * Scroll to and focus what the user must act on for this task: the first unticked consent box, else the Start button
 * (plan), or the Approve button (run approval). Looks the target up in the DOM so the strip and the storyboard header need
 * no shared state with the card. Returns false when nothing visible was found (for example the chat is collapsed).
 */
export function focusApproval(taskId: string): boolean {
  const roots = Array.from(document.querySelectorAll<HTMLElement>(`[data-approval-task="${CSS.escape(taskId)}"]`)).filter(visible);
  const root = roots[0];
  if (!root) return false;
  const target =
    root.querySelector<HTMLElement>('input[type="checkbox"]:not(:checked)') ??
    root.querySelector<HTMLElement>('[data-testid="plan-start"]:not([disabled]), [data-testid="step-approve"]:not([disabled])') ??
    root;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  root.scrollIntoView?.({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  target.focus({ preventScroll: true });
  return true;
}

/** Plans whose approval block has already been scrolled into view; survives a remount so a plan is brought forward once. */
const brought = new Set<string>();

/**
 * Bring the approval block into view once per plan, the first time it is laid out (a hidden pane has no layout, so the
 * scroll waits until the pane is shown). After that the user's own scrolling is never fought.
 */
export function useBringIntoView(ref: RefObject<HTMLElement | null>, key: string, active: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el || brought.has(key)) return;
    const go = () => {
      brought.add(key);
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView?.({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    };
    if (typeof IntersectionObserver === 'undefined') return go();
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.boundingClientRect.width > 0 && e.boundingClientRect.height > 0)) {
        io.disconnect();
        go();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, key, active]);
}

/** The same call to action, repeated where the eye already is: a notice with one button. */
export function ApprovalNotice({ approval, onReview, variant }: { approval: Approval; onReview: () => void; variant: 'strip' | 'storyboard' }) {
  const run = approval.kind === 'run';
  return (
    <div className="ag-callout" data-variant={variant} data-kind={approval.kind} data-testid={variant === 'strip' ? 'agent-ops-approval' : 'sb-approval'}>
      <BellRing size={16} aria-hidden="true" className="ag-callout-ico" />
      <div className="ag-callout-text">
        <strong>{approval.notice}</strong>
        {variant === 'storyboard' && <span>{approval.line}</span>}
      </div>
      <button type="button" className="ag-callout-btn" onClick={onReview} data-testid={variant === 'strip' ? 'agent-ops-review' : 'sb-review'}>
        {run ? RUN_APPROVAL_BUTTON : APPROVAL_BUTTON}
      </button>
    </div>
  );
}

/** A polite live region that says the approval text after mount, so assistive tech reads it as a change. */
export function useAnnounce(text: string): string {
  const [said, setSaid] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSaid(text), 150);
    return () => clearTimeout(t);
  }, [text]);
  return said;
}
