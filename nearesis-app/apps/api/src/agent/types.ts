export type ConsentKey = "spend_credits" | "publish_public" | "freeze_hypothesis" | "archive_workspace";
export const CONSENT_KEYS: readonly ConsentKey[] = [
  "spend_credits",
  "publish_public",
  "freeze_hypothesis",
  "archive_workspace",
];

export interface StepResultItem {
  label: string;
  value: string;
  href: string | null;
}
export interface StepResult {
  summary: string;
  items: StepResultItem[];
}
export interface StepWaiting {
  kind: "approval";
  runId: string;
  approvalId: string;
  approvalKind: string;
  summary: string;
  costLimit: string | null;
}
export interface StepError {
  reasonCode: string;
  message: string;
  retryable: boolean;
  /** Present when the API listed what the user must acknowledge (publish): retry with these in `acknowledge`. */
  acknowledge?: string[];
}
export interface CostEntryView {
  label: string;
  unit: "usd" | "yoctoNEAR";
  amount: string;
  txHash: string | null;
}
export type StepState = "pending" | "running" | "waiting_user" | "done" | "failed" | "skipped";
export interface StepView {
  idx: number;
  key: string;
  title: string;
  detail: string;
  state: StepState;
  startedAt: string | null;
  finishedAt: string | null;
  progress: string | null;
  result: StepResult | null;
  waiting: StepWaiting | null;
  cost: { modelUsd: string; modelCalls: number; creditsYocto: string; entries: CostEntryView[] };
  error: StepError | null;
}
export type TaskState = "proposed" | "running" | "waiting_user" | "completed" | "failed" | "cancelled";
export interface ConsentRequirement {
  key: ConsentKey;
  label: string;
  detail: string;
  maxYocto: string | null;
}
export interface TaskView {
  id: string;
  threadId: string;
  workspaceId: string | null;
  title: string;
  state: TaskState;
  currentStep: number;
  steps: StepView[];
  consent: { required: ConsentRequirement[]; given: ConsentKey[] };
  estimate: { creditsMaxYocto: string | null; modelUsdMax: string };
  cost: { modelUsd: string; modelCalls: number; creditsChargedYocto: string; creditsHeldYocto: string };
  links: {
    workspaceId: string | null;
    runId: string | null;
    capsuleId: string | null;
    proofId: string | null;
    publicationId: string | null;
    reportUrl: string | null;
  };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface MessageView {
  id: string;
  role: "user" | "assistant";
  state: "pending" | "ready" | "failed";
  createdAt: string;
  kind: "text" | "answer" | "plan" | "result" | "notice";
  text: string | null;
  answer: unknown | null;
  /** Additive: structured rows of a `direct` lookup or of a finished task. */
  rows: StepResultItem[] | null;
  taskId: string | null;
  cost: { modelUsd: string; modelCalls: number };
  error: { reasonCode: string; message: string } | null;
}
export interface ThreadView {
  id: string;
  title: string;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Ids the steps produced and later steps consume. */
export interface TaskCtx {
  workspaceId?: string;
  runId?: string;
  capsuleId?: string;
  proofId?: string;
  publicationId?: string;
  hypothesisId?: string;
  reportUrl?: string;
}
