/** Wire shapes for the Agent tab (POST /v1/assistant/answer and POST /v1/workspaces/:id/assistant/setup). */

export type AnswerStatus = 'ok' | 'partial' | 'cannot_answer';

export type AgentChart = {
  id: string;
  title: string;
  kind: 'line' | 'bar' | 'table';
  unit: string | null;
  x: string[];
  series: { name: string; values: (string | null)[] }[];
  columns: string[];
  rows: (string | null)[][];
  source: string;
  window: { from: string; to: string } | null;
  coverage: string | null;
  metricVersion: string | null;
  caveats: string[];
};

export type AgentFinding = {
  statement: string;
  basis: 'observation' | 'inference';
  status: 'supported' | 'mixed' | 'insufficient_data' | 'cannot_compute';
  chartIds: string[];
  facts: { value: string; unit: string | null }[];
  limitations: string[];
  skepticNotes: string[];
  skepticVerdict: 'holds' | 'weakened' | 'unsupported' | 'unavailable';
};

export type AgentStep = { tool: string; label: string; outcome: 'ok' | 'cannot_compute' | 'refused' | 'error'; ms: number };

export type AgentAnswer = {
  answerId: string;
  status: AnswerStatus;
  summary: string | null;
  charts: AgentChart[];
  findings: AgentFinding[];
  limitations: string[];
  steps: AgentStep[];
  cannotAnswerReason: string | null;
  suggestedWorkspaceObjective: string;
  cost: { usd: number | null; modelCalls: number | null };
  elapsedMs: number | null;
};

export type SetupItem = { id: string; title: string; reason: string };
export type AgentSetup = {
  markers: SetupItem[];
  monitors: SetupItem[];
  hypothesis: { id: string; title: string } | null;
  skipped: { kind: 'marker' | 'monitor' | 'hypothesis'; reason: string }[];
  cost: { usd: number | null; modelCalls: number | null };
};

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => arr<unknown>(v).filter((x): x is string => typeof x === 'string');
const cell = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'string' ? v : String(v));

/**
 * Normalise a response so the renderer never crashes on an omitted array. Missing values stay unknown (null or empty),
 * a missing number is never turned into 0.
 */
export function normalizeAnswer(raw: unknown): AgentAnswer {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const status: AnswerStatus = r.status === 'ok' || r.status === 'partial' || r.status === 'cannot_answer' ? r.status : 'cannot_answer';
  const cost = (r.cost && typeof r.cost === 'object' ? r.cost : {}) as Record<string, unknown>;
  return {
    answerId: str(r.answerId) ?? '',
    status,
    summary: str(r.summary),
    charts: arr<Record<string, unknown>>(r.charts).map((c, i) => {
      const w = c.window && typeof c.window === 'object' ? (c.window as Record<string, unknown>) : null;
      return {
        id: str(c.id) ?? `c${i + 1}`,
        title: str(c.title) ?? 'Untitled chart',
        kind: c.kind === 'bar' || c.kind === 'table' ? c.kind : 'line',
        unit: str(c.unit),
        x: arr<unknown>(c.x).map((v) => String(v)),
        series: arr<Record<string, unknown>>(c.series).map((s) => ({ name: str(s.name) ?? '', values: arr<unknown>(s.values).map(cell) })),
        columns: strs(c.columns),
        rows: arr<unknown>(c.rows).map((row) => arr<unknown>(row).map(cell)),
        source: str(c.source) ?? '',
        window: w && str(w.from) && str(w.to) ? { from: str(w.from)!, to: str(w.to)! } : null,
        coverage: str(c.coverage),
        metricVersion: str(c.metricVersion),
        caveats: strs(c.caveats),
      };
    }),
    findings: arr<Record<string, unknown>>(r.findings).map((f) => ({
      statement: str(f.statement) ?? '',
      basis: f.basis === 'inference' ? 'inference' : 'observation',
      status: (['supported', 'mixed', 'insufficient_data', 'cannot_compute'] as const).find((s) => s === f.status) ?? 'cannot_compute',
      chartIds: strs(f.chartIds),
      facts: arr<Record<string, unknown>>(f.facts).map((x) => ({ value: str(x.value) ?? '', unit: str(x.unit) })),
      limitations: strs(f.limitations),
      skepticNotes: strs(f.skepticNotes),
      skepticVerdict: (['holds', 'weakened', 'unsupported', 'unavailable'] as const).find((s) => s === f.skepticVerdict) ?? 'unavailable',
    })),
    limitations: strs(r.limitations),
    steps: arr<Record<string, unknown>>(r.steps).map((s) => ({
      tool: str(s.tool) ?? '',
      label: str(s.label) ?? str(s.tool) ?? 'step',
      outcome: (['ok', 'cannot_compute', 'refused', 'error'] as const).find((o) => o === s.outcome) ?? 'error',
      ms: numOrNull(s.ms) ?? 0,
    })),
    cannotAnswerReason: str(r.cannotAnswerReason),
    suggestedWorkspaceObjective: str(r.suggestedWorkspaceObjective) ?? '',
    cost: { usd: numOrNull(cost.usd), modelCalls: numOrNull(cost.modelCalls) },
    elapsedMs: numOrNull(r.elapsedMs),
  };
}

export function normalizeSetup(raw: unknown): AgentSetup {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const item = (x: Record<string, unknown>): SetupItem => ({ id: str(x.id) ?? '', title: str(x.title) ?? '', reason: str(x.reason) ?? '' });
  const h = r.hypothesis && typeof r.hypothesis === 'object' ? (r.hypothesis as Record<string, unknown>) : null;
  const cost = (r.cost && typeof r.cost === 'object' ? r.cost : {}) as Record<string, unknown>;
  return {
    markers: arr<Record<string, unknown>>(r.markers).map(item),
    monitors: arr<Record<string, unknown>>(r.monitors).map(item),
    hypothesis: h && str(h.id) ? { id: str(h.id)!, title: str(h.title) ?? '' } : null,
    skipped: arr<Record<string, unknown>>(r.skipped).map((s) => ({
      kind: s.kind === 'monitor' || s.kind === 'hypothesis' ? s.kind : 'marker',
      reason: str(s.reason) ?? '',
    })),
    cost: { usd: numOrNull(cost.usd), modelCalls: numOrNull(cost.modelCalls) },
  };
}

/** Chart points for SeriesChart: values stay decimal strings (parsed only when drawn), null stays a gap. */
export function chartPoints(c: AgentChart): { name: string; points: { x: string; y: string | null }[] }[] {
  return c.series.map((s) => ({ name: s.name, points: c.x.map((x, i) => ({ x, y: s.values[i] ?? null })) }));
}

/** The turns the model sees as context: the last few, each trimmed to the API limit. */
export type HistoryEntry = { role: 'user' | 'assistant'; text: string };
export function buildHistory(turns: { kind: string; text?: string; answer?: AgentAnswer }[], max = 6): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const t of turns) {
    if (t.kind === 'user' && t.text) out.push({ role: 'user', text: t.text.slice(0, 2000) });
    else if (t.kind === 'answer' && t.answer) {
      const text = t.answer.summary ?? t.answer.cannotAnswerReason;
      if (text) out.push({ role: 'assistant', text: text.slice(0, 2000) });
    }
  }
  return out.slice(-max);
}
