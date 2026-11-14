import type {
  ApprovalView,
  BudgetView,
  RunCardModel,
  RunView,
  ThreadItem,
  TimelineEvent,
} from "@nearesis/ui";

export const RUN_ID = "7c1f0a52-3b8e-4d6a-9a41-0d2b5e8f9a10";
export const ACTION_HASH = "sha256:9f2c4e7ab1d3058c6e4f0b7a2d9c31e85a4b6f70c2d1e93a8b5c7d0f4e2a6b19";
const t = (s: number) => new Date(Date.UTC(2026, 10, 10, 9, 30, s)).toISOString();

const BUDGET: BudgetView = {
  tokens: { used: null, total: 60000 },
  toolCalls: { used: null, total: 16 },
  usd: { used: null, total: 1 },
};

export const QUESTION =
  "Did solver fill rates drop on Solana after the 24 October outage, and who absorbed the volume?";

const base = (state: RunView["state"]): RunView => ({
  runId: RUN_ID,
  workspaceId: "00000000-0000-4000-8000-0000000000a1",
  state,
  terminal: ["COMPLETE", "PARTIAL", "BLOCKED", "CANCELLED"].includes(state),
  version: 3,
  failure: null,
  result: null,
  rootTask: null,
  children: [],
  evidenceLinks: [],
});

/** The full scripted event list. Each index is revealed in order by the mock stream or sliced by the static seeds. */
export const EVENTS: TimelineEvent[] = [
  { id: "e1", kind: "state", at: t(0), state: "REQUESTED" },
  {
    id: "e2",
    kind: "state",
    at: t(1),
    state: "PLANNING",
    note: "Splitting the question into two hypotheses.",
  },
  {
    id: "e3",
    kind: "agent",
    at: t(2),
    role: "director",
    objective: "Plan fill-rate and volume-share checks",
    taskId: "k1",
    parentTaskId: null,
    status: "RUNNING",
  },
  {
    id: "e4",
    kind: "agent",
    at: t(3),
    role: "semantic_analyst",
    objective: "Fill rate by chain, 17 to 31 October",
    taskId: "k2",
    parentTaskId: "k1",
    status: "RUNNING",
  },
  {
    id: "e5",
    kind: "query",
    at: t(4),
    taskId: "k2",
    metric: "solver.fill_rate by chain",
    queryHash: "b41d0c7e92aa5f31",
    rows: 124,
    certification: "certified",
  },
  {
    id: "e6",
    kind: "agent",
    at: t(5),
    role: "quant",
    objective: "Volume share of fills by solver",
    taskId: "k3",
    parentTaskId: "k1",
    status: "RUNNING",
  },
  {
    id: "e7",
    kind: "abstention",
    at: t(6),
    taskId: "k3",
    metric: "solver.volume_share",
    reason: "Solver identity is not attested for 24 to 26 October, so shares would be guesses.",
  },
  { id: "e8", kind: "approval", at: t(7), approvalId: "9041" },
  {
    id: "e9",
    kind: "state",
    at: t(8),
    state: "EXECUTING",
    note: "Approved. Running the pinned snapshot query.",
  },
  {
    id: "e10",
    kind: "query",
    at: t(9),
    taskId: "k2",
    metric: "intents.settled_volume by chain",
    queryHash: "e07a31bb5c8d64f2",
    rows: 41,
    certification: "experimental",
  },
  { id: "e11", kind: "state", at: t(10), state: "EVIDENCE_REVIEW" },
  {
    id: "e12",
    kind: "panel",
    at: t(11),
    panelId: "p-fill",
    title: "Fill rate by chain",
    queryHash: "b41d0c7e92aa5f31",
    added: false,
  },
  {
    id: "e13",
    kind: "panel",
    at: t(12),
    panelId: "p-vol",
    title: "Settled volume, Solana",
    queryHash: "e07a31bb5c8d64f2",
    added: false,
  },
  { id: "e14", kind: "state", at: t(13), state: "PARTIAL", note: "One branch could not be computed." },
];

export const APPROVAL_PENDING: ApprovalView = {
  approvalId: "9041",
  actionHash: ACTION_HASH,
  status: "pending",
  kind: "snapshot.pin",
  network: "clickhouse.read",
  costLimit: 0.2,
  requestedAt: t(7),
  decidedBy: null,
  decidedAt: null,
};

export const SUMMARY =
  "Fill rate on Solana fell from 94.1% to 87.6% in the three days after the outage and recovered by 29 October. Ethereum and Base fills were flat. Volume share by solver cannot be computed for the outage window because solver identity is unattested; the two proposed panels show what is measurable.";

export type SeedName = "empty" | "running" | "approval" | "complete" | "blocked";

/** Static run seeds for screenshots; the live mock builds the same shapes incrementally. */
export function seed(name: SeedName): { thread: ThreadItem[]; runs: Record<string, RunCardModel> } {
  if (name === "empty") return { thread: [], runs: {} };
  const thread: ThreadItem[] = [
    { id: "u1", role: "user", text: QUESTION, at: t(0) },
    { id: "r1", role: "run", runId: RUN_ID, at: t(0) },
  ];
  const mk = (n: number, state: RunView["state"], extra: Partial<RunCardModel> = {}): RunCardModel => ({
    run: base(state),
    events: EVENTS.slice(0, n),
    approvals: [],
    budget: {
      ...BUDGET,
      tokens: { used: 21400, total: 60000 },
      toolCalls: { used: 5, total: 16 },
      usd: { used: 0.18, total: 1 },
    },
    ...extra,
  });
  if (name === "running") return { thread, runs: { [RUN_ID]: mk(6, "EXECUTING") } };
  if (name === "approval")
    return { thread, runs: { [RUN_ID]: mk(8, "APPROVAL_NEEDED", { approvals: [APPROVAL_PENDING] }) } };
  if (name === "blocked")
    return {
      thread,
      runs: {
        [RUN_ID]: mk(8, "BLOCKED", {
          run: {
            ...base("BLOCKED"),
            failure: {
              reasonCode: "APPROVAL_REJECTED",
              retryability: "human_action_needed",
              humanActionNeeded:
                "The snapshot pin was rejected. Ask again with snapshotPolicy live, or approve a pin.",
              lastCheckpoint: "planning",
              replayCommand: `pnpm replay --run ${RUN_ID.slice(0, 8)}`,
            },
          },
          approvals: [{ ...APPROVAL_PENDING, status: "rejected", decidedBy: "you", decidedAt: t(9) }],
        }),
      },
    };
  return {
    thread,
    runs: {
      [RUN_ID]: mk(14, "PARTIAL", {
        approvals: [{ ...APPROVAL_PENDING, status: "approved", decidedBy: "you", decidedAt: t(8) }],
        summary: SUMMARY,
        summaryDone: true,
        citations: [
          { id: "c1", label: "Fill rate by chain", queryHash: "b41d0c7e92aa5f31", sourceLabel: "LIVE" },
          { id: "c2", label: "Settled volume", queryHash: "e07a31bb5c8d64f2", sourceLabel: "LIVE" },
        ],
        panels: [
          { panelId: "p-fill", title: "Fill rate by chain", added: true },
          { panelId: "p-vol", title: "Settled volume, Solana", added: false },
        ],
        budget: {
          tokens: { used: 48200, total: 60000 },
          toolCalls: { used: 11, total: 16 },
          usd: { used: 0.52, total: 1 },
        },
      }),
    },
  };
}
