'use client';

import './five.css';
import Link from 'next/link';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { FOLLOW_UP_HINT, FOLLOW_UP_LABEL, agentFollowUpHref, createAndDigMessage, followUpMessage, type FollowUpKind } from '@/lib/agent/followups';

/**
 * Where a follow-up goes. The Agent page and the docked Ask panel provide one: `fill` puts text into their composer,
 * focuses it and scrolls it into view (it never sends). Without one (the thesis viewer) the actions are links to /agent.
 */
export type ComposerBridge = { fill: (text: string) => void; workspaceId: string | null };

const Ctx = createContext<ComposerBridge | null>(null);

export function ComposerBridgeProvider({ value, children }: { value: ComposerBridge; children: ReactNode }) {
  const v = useMemo(() => value, [value]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export const useComposerBridge = () => useContext(Ctx);

const KINDS: FollowUpKind[] = ['dig', 'opposite', 'extend'];

/**
 * Three small actions under a finding. In a composer context they fill the composer; when that context has no workspace
 * they offer one create-and-investigate action instead; elsewhere they link to the Agent page bound to `workspaceId`.
 * Nothing renders when there is no workspace to work in.
 */
export default function FollowUpActions({ statement, workspaceId = null, objective = null, testId = 'followups' }: { statement: string; workspaceId?: string | null; objective?: string | null; testId?: string }) {
  const bridge = useComposerBridge();
  if (!statement.trim()) return null;
  if (bridge) {
    if (!bridge.workspaceId)
      return (
        <div className="fu-row" data-testid={testId} role="group" aria-label="Follow up on this finding">
          <button type="button" className="fu-btn" onClick={() => bridge.fill(createAndDigMessage(statement, objective))} title="Fills the message box with a request to create a workspace and investigate. Nothing is sent." data-testid="followup-create">
            Create a workspace and dig in
          </button>
        </div>
      );
    return (
      <div className="fu-row" data-testid={testId} role="group" aria-label="Follow up on this finding">
        {KINDS.map((k) => (
          <button key={k} type="button" className="fu-btn" onClick={() => bridge.fill(followUpMessage(k, statement))} title={FOLLOW_UP_HINT[k]} data-testid={`followup-${k}`}>
            {FOLLOW_UP_LABEL[k]}
          </button>
        ))}
      </div>
    );
  }
  if (!workspaceId) return null;
  return (
    <div className="fu-row" data-testid={testId} role="group" aria-label="Follow up on this finding">
      {KINDS.map((k) => (
        <Link key={k} className="fu-btn" href={agentFollowUpHref(workspaceId, followUpMessage(k, statement))} title="Opens the Agent on a new conversation in this thesis's workspace, with the message ready. Nothing is sent." data-testid={`followup-${k}`}>
          {FOLLOW_UP_LABEL[k]}
        </Link>
      ))}
    </div>
  );
}
