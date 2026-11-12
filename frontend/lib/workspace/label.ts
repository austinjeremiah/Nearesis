/** Workspaces carry an objective, not a name. The short label used in headings and the sidebar. */
export function workspaceLabel(objective: string, max = 64): string {
  const s = objective.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
