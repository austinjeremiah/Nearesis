/** Display rules for the agent rows of an investigation run. Read-only: nothing here changes what the API reports. */

const DESCRIPTION: Record<string, string> = {
  director: 'plans the investigation and checks the result',
  composer: 'writes the queries and builds the charts',
  semantic_analyst: 'finds the certified metrics and runs the semantic queries',
  data_scout: 'checks which sources can answer the question',
  quant: 'runs the statistical comparisons',
  skeptic: 'looks for evidence against the findings',
  economics: 'ties the findings to the economics behind them',
  monitoring: 'sets up the alerts that watch the result',
  auditor: 'checks every claim against its evidence',
  publisher: 'writes up the thesis for publishing',
};

/** "director" becomes "Director agent"; "semantic_analyst" becomes "Semantic analyst agent". */
export function agentLabel(role: string): string {
  const words = role.trim().replace(/[_-]+/g, ' ').toLowerCase();
  const cap = words ? words[0]!.toUpperCase() + words.slice(1) : 'Unknown';
  return `${cap} agent`;
}

/** One plain line on what the role does; null for a role this page does not know (nothing is guessed). */
export const agentDescription = (role: string): string | null => DESCRIPTION[role.trim().toLowerCase()] ?? null;

export type AgentDisplay = { state: 'finished' | 'failed' | 'live' | 'pending'; word: string };

const DONE = /^(DONE|COMPLETE|COMPLETED|SUCCEEDED|SUCCESS)$/i;
const FAILED = /FAIL|CANCEL|REJECT|ERROR/i;

/**
 * The state shown for one agent. Display rule, not an API change: the API leaves the director sub-task as RUNNING after
 * the run has ended, so once the run is terminal an agent that did not fail or get cancelled is shown as "finished".
 * An agent of a run that is still going shows what the API says.
 */
export function agentDisplay(status: string, runTerminal: boolean): AgentDisplay {
  if (FAILED.test(status)) return { state: 'failed', word: status.toLowerCase().replace(/_/g, ' ') };
  if (DONE.test(status) || runTerminal) return { state: 'finished', word: 'finished' };
  if (/^(PENDING|QUEUED|WAITING|CREATED)$/i.test(status)) return { state: 'pending', word: status.toLowerCase() };
  return { state: 'live', word: status.toLowerCase().replace(/_/g, ' ') };
}

/** Indexes of the rows that show the role description: the first row of each role. */
export function firstOfRole(roles: string[]): Set<number> {
  const seen = new Set<string>();
  const out = new Set<number>();
  roles.forEach((r, i) => {
    if (!seen.has(r)) {
      seen.add(r);
      out.add(i);
    }
  });
  return out;
}
