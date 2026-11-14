/** Harmless per-viewer UI preferences. Conversations live on the server; this holds only which thread was open. */
const KEY = 'nearesis.agent.prefs.v2';
export type AgentPrefs = { threadId: string | null; workspaceId: string | null };

export function loadPrefs(): AgentPrefs {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const p = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return { threadId: typeof p.threadId === 'string' ? p.threadId : null, workspaceId: typeof p.workspaceId === 'string' ? p.workspaceId : null };
  } catch {
    return { threadId: null, workspaceId: null };
  }
}

export function savePrefs(p: AgentPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode or blocked storage: the preference is simply not remembered */
  }
}
