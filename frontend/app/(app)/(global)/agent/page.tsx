import type { Metadata } from 'next';
import AgentWorkspace from '@/components/nx/agent/agent-workspace';
import { safeWorkspaceParam } from '@/lib/agent/followups';

export const metadata: Metadata = { title: 'Agent · Nearesis' };

/**
 * Agent: charts in the middle, the agent chat on the right. `q` carries a question from the Home ask box (or a follow-up from a thesis, with `w` the workspace to bind); the workspace
 * answers it once and removes it from the URL.
 */
export default async function AgentPage({ searchParams }: { searchParams: Promise<{ q?: string | string[]; w?: string | string[] }> }) {
  const sp = await searchParams;
  const q = Array.isArray(sp.q) ? sp.q[0] : sp.q;
  return <AgentWorkspace initialQuestion={q?.trim() ? q.slice(0, 2000) : null} initialWorkspace={safeWorkspaceParam(sp.w)} />;
}
