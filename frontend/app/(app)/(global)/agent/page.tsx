import type { Metadata } from 'next';
import AgentWorkspace from '@/components/nx/agent/agent-workspace';

export const metadata: Metadata = { title: 'Agent · Nearesis' };

/**
 * Agent: charts in the middle, the agent chat on the right. `q` carries a question from the Home ask box; the workspace
 * answers it once and removes it from the URL.
 */
export default async function AgentPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const sp = await searchParams;
  const q = Array.isArray(sp.q) ? sp.q[0] : sp.q;
  return <AgentWorkspace initialQuestion={q?.trim() ? q.slice(0, 2000) : null} />;
}
