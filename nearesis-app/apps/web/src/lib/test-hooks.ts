/** Read-only instrumentation used by acceptance tests (registry instantiation log, chart handles, counters). */
export interface NearesisHooks {
  ready: boolean;
  instantiated: string[];
  charts: Record<string, unknown>;
  agentSpawnCount: number;
  stateLog: Record<string, string[]>;
  firstFrameMs: Record<string, number>;
  lastError: string | null;
  [k: string]: unknown;
}

export function hooks(): NearesisHooks {
  const w = globalThis as unknown as { __nearesis?: NearesisHooks };
  if (!w.__nearesis)
    w.__nearesis = {
      ready: false,
      instantiated: [],
      charts: {},
      agentSpawnCount: 0,
      stateLog: {},
      firstFrameMs: {},
      lastError: null,
    };
  return w.__nearesis;
}
