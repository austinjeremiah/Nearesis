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
/**
 * Ids of what a step produced or worked on, so a client can load the real objects (run, markers, monitor rules, hypothesis,
 * capsule, proof) instead of only showing their titles. Only ids the step actually has are present.
 */
export interface StepRefs {
  workspaceId?: string;
  runId?: string;
  capsuleId?: string;
  proofId?: string;
  publicationId?: string;
  hypothesisId?: string;
  thesisId?: string;
  markerIds?: string[];
  monitorIds?: string[];
  skipped?: Array<{ kind: string; reason: string }>;
  /** setup.auto: why each marker was created (the setup route's own reason text). */
  markerReasons?: Array<{ id: string; reason: string }>;
  /** setup.auto: why each monitor rule exists and which cited value its threshold comes from. */
  monitorReasons?: Array<{ id: string; reason: string; thresholdFrom: string | null }>;
  /** question.ask / run.await: why each panel was drawn, only when the run recorded a reason for every panel. */
  queryNotes?: Array<{ panelTitle: string; why: string }>;
}
export interface StepResult {
  summary: string;
  items: StepResultItem[];
  refs?: StepRefs;
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
  /** CREDITS_EXHAUSTED: `{ allowanceUsd, spentUsd, availableUsd, requiredUsd | null, contactEmail }`. */
  details?: Record<string, unknown>;
}
export interface CostEntryView {
  label: string;
  unit: "usd";
  /** USD, 6 places. */
  amount: string;
  txHash: string | null;
  /** On-chain entries carry the NEAR amounts and the rate they were converted at. */
  detail?: Record<string, unknown>;
}
export type StepState = "pending" | "running" | "waiting_user" | "done" | "failed" | "skipped";
export interface StepView {
  idx: number;
  key: string;
  title: string;
  detail: string;
  /** One line (at most 220 characters) on why this step is in the plan; the planner's, else a fixed sentence per step key. */
  why: string;
  state: StepState;
  startedAt: string | null;
  finishedAt: string | null;
  progress: string | null;
  result: StepResult | null;
  waiting: StepWaiting | null;
  /** `creditsUsd` is the on-chain part (OutLayer, anchor gas); what the step charged the user is modelUsd + creditsUsd. */
  cost: { modelUsd: string; modelCalls: number; creditsUsd: string; entries: CostEntryView[] };
  error: StepError | null;
}
export type TaskState = "proposed" | "running" | "waiting_user" | "completed" | "failed" | "cancelled";
export interface ConsentRequirement {
  key: ConsentKey;
  label: string;
  detail: string;
  /** Most the on-chain part of this consent can charge, USD with 6 places (null when it cannot be estimated). */
  maxUsd: string | null;
}
/**
 * The claim on record before the data is seen. `statement: null` means none was written (the card asks the user to write it).
 * `lockedAt` and `sha256` are set by Start and never change afterwards.
 */
export interface TestPlanView {
  statement: string | null;
  xLabel: string | null;
  yLabel: string | null;
  relation: "moves_with" | "leads";
  lagDays: number;
  expectedSign: "positive" | "negative" | "either";
  windowDays: number;
  wouldCountAsWrong: string | null;
  editedByUser: boolean;
  lockedAt: string | null;
  sha256: string | null;
}
export interface TaskView {
  id: string;
  threadId: string;
  workspaceId: string | null;
  title: string;
  state: TaskState;
  /** null for a task whose plan has no question.ask (nothing to test). */
  testPlan: TestPlanView | null;
  currentStep: number;
  steps: StepView[];
  consent: { required: ConsentRequirement[]; given: ConsentKey[] };
  estimate: { creditsMaxUsd: string | null; modelUsdMax: string };
  cost: {
    modelUsd: string;
    modelCalls: number;
    creditsUsd: string;
    creditsHeldUsd: string;
    entries: CostEntryView[];
  };
  links: {
    workspaceId: string | null;
    runId: string | null;
    capsuleId: string | null;
    proofId: string | null;
    publicationId: string | null;
    thesisId: string | null;
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
  error: { reasonCode: string; message: string; details?: Record<string, unknown> } | null;
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
  thesisId?: string;
  reportUrl?: string;
  /** The test plan the setup step drafted with the hypothesis (ids only); `thesis.build` passes it on. */
  testPlan?: {
    x: { panelHash: string; column: string };
    y: { panelHash: string; column: string };
    lagDays: number;
    expectedSign: "positive" | "negative" | "either";
    chosenBy: "planner" | "rule";
  };
  /** Set when no capsule could be built, so the thesis step can say why there is no thesis. */
  noThesisReason?: string;
  /**
   * The two series of the task's test plan found in the finished run (ids), or why they were not. Written once, by the first
   * step that needs the pair; `capsule.build` and `thesis.build` then pass it as the explicit test.
   */
  testResolution?:
    | {
        status: "resolved";
        by: "name" | "model";
        x: { panelHash: string; column: string; panelTitle: string };
        y: { panelHash: string; column: string; panelTitle: string };
      }
    | { status: "missing"; label: string; message: string };
}
