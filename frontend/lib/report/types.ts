/** Shape of `GET /v1/workspaces/:id/report`. Only the fields the print report reads are typed; unknown stays null. */
export type Fact = { unit: string | null; value: string; resultRef?: { column?: string; rowIds?: string[]; queryHash?: string } };
export type ReportFinding = {
  id: string;
  kind?: string;
  basis?: string;
  status?: string;
  statement: string;
  facts?: Fact[];
  limitations?: string[];
  skepticNotes?: string[];
  skepticVerdict?: string | null;
  skepticDegraded?: boolean;
  panelHashes: string[];
};
export type ReportRun = {
  id: string;
  question: string | null;
  state: string;
  terminal: boolean;
  source: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  budget: { spent?: { usd?: number | null } } | null;
  interpretation: { state: string; reason: string | null; findingCount: number; summary: string | null; findings: ReportFinding[] };
  panelHashes: string[];
};
export type PanelColumn = { name: string; unit: string | null };
export type ReportPanel = {
  hash: string;
  title: string | null;
  kind: string | null;
  encoding: { x?: string; y?: string[] } | null;
  unit: string | null;
  source: string | null;
  window: { from: string; to: string } | null;
  metricVersion: string | null;
  coverage: { state: string | null; gaps: number | null; nullCount: number | null; partialCount: number | null; freshness: string | null; sourceWatermark: string | null } | null;
  caveats: string[];
  gaps: { from: string; to: string; reason: string }[];
  runIds: string[];
  data: { state?: string; chart: { columns: PanelColumn[]; rows: (string | number | null)[][]; downsampling?: { originalPoints?: number } } | null; cannotCompute?: { explanation: string } | null } | null;
  error: { status: number; reasonCode: string } | null;
};
export type ReportHypothesis = { hypothesisId: string; proposition: string; target?: string; predictor?: string; benchmark?: string; falsification?: string; status: string; registered?: boolean; registrationHash?: string | null; verdict?: string | null; strength?: string | null; version?: number; createdAt?: string };
export type ReportMarker = { markerId: string; anchorType: string; anchor: Record<string, unknown>; question?: string | null; status: string; timestamp: string; mode?: string };
export type ReportMonitor = {
  ruleId: string;
  name: string;
  sourceId: string;
  condition: { kind?: string; op?: string; value?: number; metricId?: string; [k: string]: unknown };
  enabled: boolean;
  cooldownSeconds?: number;
  action?: string;
  lastEvaluation: { status: string; evaluatedAt: string; watermark?: string; evaluatedValue?: { values?: Record<string, number | null> } } | null;
  triggers: { triggerId?: string; firedAt?: string; createdAt?: string; mode?: string; status?: string }[];
  triggerCount: number;
};
export type ReportProof = {
  proofId: string;
  state: string;
  createdAt: string;
  job: { requestId: string | null; txHash: string | null; explorerUrl: string | null };
  wasmSha256: string;
  inputSha256: string;
  outputSha256: string | null;
  verification: { decision: string | null; reasons: string[]; mrTd: string | null; rtmr3: string | null };
  /** USD first; NEAR amounts and the rate are secondary. Fields an older API omits are undefined (shown as unknown). */
  cost: { heldUsd?: string | null; chargedUsd?: string | null; gasUsd?: string | null; totalUsd?: string | null; chargedYocto?: string | null; gasYocto?: string | null; totalYocto?: string | null; nearUsdRate?: string | number | null; rateDate?: string | null };
  error: string | null;
};
export type ReportCapsule = {
  capsuleId: string;
  title: string | null;
  label: string | null;
  createdAt: string | null;
  hashes?: Record<string, string | null>;
  results?: { id: string; label: string; value: string; unit: string | null }[];
  verification?: { local?: { status: string; detail?: string }; outlayer?: { status: string; detail?: string; jobId?: string | null } };
  limitations?: string[];
  proofs: ReportProof[];
  publication: { state: string | null; public: boolean; badge: string | null; publishedAt: string | null; acknowledged: string[] };
};
export type CostEntry = { source: string; label: string; unit: 'usd' | 'yoctoNEAR'; amount: string; at: string | null; ref: string | null; txHash: string | null; kind?: string; detail?: Record<string, unknown> | null };
export type ReportDoc = {
  generatedAt: string;
  workspace: { id: string; objective: string; networkScope: string; version: number; createdAt: string; archivedAt: string | null; owner: { displayName: string | null; nearAccountId: string | null } | null; dataWindow: { from: string; to: string } | null };
  runs: ReportRun[];
  panels: ReportPanel[];
  hypotheses: ReportHypothesis[];
  markers: ReportMarker[];
  monitors: ReportMonitor[];
  capsules: ReportCapsule[];
  costs: { modelUsd: string | null; creditsChargedUsd?: string | null; creditsChargedYocto?: string | null; entries: CostEntry[]; ledger: { spentUsd: string | null }; basis: string };
  limitations: string[];
};
