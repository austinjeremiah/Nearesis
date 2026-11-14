import { createHash } from "node:crypto";
import { QUESTION_BUDGET } from "./catalog.ts";
import { ApiError, call, apiErrorOf } from "./api-client.ts";
import type { AgentApi, AgentUser } from "./api-client.ts";
import type { StepResult, StepResultItem, StepWaiting, TaskCtx } from "./types.ts";

/** A failure with the reason shown to the user. Thrown by step handlers. */
export class StepFail extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export type Outcome =
  { kind: "done"; result: StepResult } | { kind: "waiting"; waiting: StepWaiting; progress: string };

export interface CostReport {
  label: string;
  unit: "usd" | "yoctoNEAR";
  amount: string;
  /** Model calls this entry stands for (usd entries). */
  calls?: number;
  txHash?: string | null;
  sourceKey: string;
}

export interface Env {
  user: AgentUser;
  taskId: string;
  threadId: string;
  idx: number;
  /** 0 for the first attempt; counts retries of this step. */
  attempt: number;
  params: Record<string, unknown>;
  ctx: TaskCtx;
  startedAtMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  api: AgentApi;
  /** Idempotency-Key derived from the task id and step index. */
  key(suffix?: string): string;
  patchCtx(p: Partial<TaskCtx>): Promise<void>;
  setWorkspace(id: string): Promise<void>;
  progress(text: string): Promise<void>;
  cancelled(): Promise<boolean>;
  cost(c: CostReport): Promise<void>;
  setHeld(yocto: string): Promise<void>;
  limits: Limits;
}
export interface Limits {
  runTimeoutMs: number;
  proofTimeoutMs: number;
  interpretationGraceMs: number;
  runVisibleGraceMs: number;
  settleWaitMs: number;
  pollMs(elapsedMs: number): number;
}
export const DEFAULT_LIMITS: Limits = {
  runTimeoutMs: 15 * 60_000,
  proofTimeoutMs: 20 * 60_000,
  interpretationGraceMs: 45_000,
  runVisibleGraceMs: 30_000,
  settleWaitMs: 60_000,
  pollMs: (e) => (e < 30_000 ? 2_000 : 4_000),
};

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const FAILED_RUN_STATES = new Set(["BLOCKED", "BLOCKED_SOURCE", "CANCELLED", "PARTIAL"]);

export function uuidFrom(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

const item = (label: string, value: string, href: string | null = null): StepResultItem => ({
  label,
  value,
  href,
});
const need = (v: string | null | undefined, what: string): string => {
  if (!v) throw new StepFail("MISSING_INPUT", `This step needs ${what}.`, false);
  return v;
};
const wsOf = (e: Env) => need(e.ctx.workspaceId, "a workspace");
const idem = (e: Env, suffix?: string): Record<string, string> => ({ "idempotency-key": e.key(suffix) });
const asApi = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) throw new StepFail(e.reasonCode, e.message, e.retryable);
    throw e;
  }
};

// ------------------------------------------------------------------ the steps

async function workspaceCreate(e: Env): Promise<Outcome> {
  const objective = String(e.params.objective);
  const key = e.key();
  const r = await call<Obj>(
    e.api,
    e.user,
    "POST",
    "/v1/workspaces",
    { objective, networkScope: "near-mainnet-read", idempotencyKey: key },
    { "idempotency-key": key },
  );
  const id = need(str(r.body.workspaceId), "the new workspace id");
  await e.setWorkspace(id);
  return {
    kind: "done",
    result: {
      summary: "Workspace created.",
      items: [item("Workspace", id, `/w/${id}`), item("Canvas", "Open the canvas", `/w/${id}/canvas`)],
    },
  };
}

async function workspaceUse(e: Env): Promise<Outcome> {
  const id = String(e.params.workspaceId);
  const r = await call<Obj>(e.api, e.user, "GET", `/v1/workspaces/${id}`);
  await e.setWorkspace(id);
  return {
    kind: "done",
    result: {
      summary: "Using the existing workspace.",
      items: [item("Workspace", str(r.body.objective)?.slice(0, 120) ?? id, `/w/${id}`)],
    },
  };
}

async function workspaceArchive(e: Env): Promise<Outcome> {
  const id = String(e.params.workspaceId ?? e.ctx.workspaceId);
  await call(e.api, e.user, "POST", `/v1/workspaces/${id}/archive`, {}, idem(e));
  return { kind: "done", result: { summary: "Workspace archived.", items: [item("Workspace", id)] } };
}

async function questionAsk(e: Env): Promise<Outcome> {
  const ws = wsOf(e);
  let question = str(e.params.question);
  if (!question) {
    const w = await call<Obj>(e.api, e.user, "GET", `/v1/workspaces/${ws}`);
    question = need(str(w.body.objective), "a question (the workspace has no objective)").slice(0, 2000);
  }
  const r = await call<Obj>(
    e.api,
    e.user,
    "POST",
    `/v1/workspaces/${ws}/questions`,
    {
      question,
      snapshotPolicy: "live",
      source: e.params.source === "fixture" ? "fixture" : "live",
      budget: QUESTION_BUDGET,
    },
    idem(e),
  );
  const runId = need(str(r.body.runId), "the run id");
  await e.patchCtx({ runId });
  return {
    kind: "done",
    result: {
      summary: "Investigation started.",
      items: [item("Run", runId, `/w/${ws}/investigate?run=${runId}`)],
    },
  };
}

interface RunView {
  state?: string;
  failure?: unknown;
  version?: number;
  children?: Array<{ status?: string }>;
  budget?: { spent?: { usd?: number; toolCalls?: number } };
  findings?: unknown[];
  interpretation?: { state?: string; reason?: string | null } | null;
}
function reasonOf(failure: unknown): string | null {
  if (typeof failure === "string") return failure;
  if (failure && typeof failure === "object")
    for (const k of ["reason", "message", "reasonCode", "code"]) {
      const v = (failure as Obj)[k];
      if (typeof v === "string") return v;
    }
  return null;
}

async function recordRunCost(e: Env, runId: string, run: RunView): Promise<void> {
  const usd = run.budget?.spent?.usd;
  if (typeof usd === "number" && usd > 0)
    await e.cost({
      label: "Investigation run (model spend)",
      unit: "usd",
      amount: usd.toFixed(6),
      calls: Math.max(0, Math.trunc(run.budget?.spent?.toolCalls ?? 0)),
      sourceKey: `run:${runId}:usd`,
    });
}

async function runAwait(e: Env): Promise<Outcome> {
  const runId = need(str(e.params.runId) ?? e.ctx.runId ?? null, "a run");
  const ws = e.ctx.workspaceId ?? "";
  const began = e.now();
  let completeSeen: number | null = null;
  for (;;) {
    if (await e.cancelled()) throw new StepFail("CANCELLED", "The task was cancelled.", false);
    const elapsed = e.now() - began;
    let run: RunView;
    try {
      run = (await call<RunView>(e.api, e.user, "GET", `/v1/runs/${runId}`)).body;
    } catch (err) {
      // The run row is written a moment after the question is accepted: an early 404 means "not visible yet".
      if (
        err instanceof ApiError &&
        err.status === 404 &&
        e.now() - e.startedAtMs < e.limits.runVisibleGraceMs
      ) {
        await e.progress("Waiting for the run to appear");
        await e.sleep(1000);
        continue;
      }
      if (err instanceof ApiError) throw new StepFail(err.reasonCode, err.message, err.retryable);
      throw err;
    }
    const state = run.state ?? "UNKNOWN";
    const kids = run.children ?? [];
    const doneKids = kids.filter((c) => /^(DONE|COMPLETE|SUCCEEDED|SKIPPED)$/i.test(c.status ?? "")).length;
    await e.progress(`Run ${state.toLowerCase().replace(/_/g, " ")}: ${doneKids}/${kids.length} tasks done`);

    if (FAILED_RUN_STATES.has(state)) {
      await recordRunCost(e, runId, run);
      const why = reasonOf(run.failure);
      throw new StepFail(`RUN_${state}`, `The run ended in ${state}${why ? `: ${why}` : ""}.`, false);
    }
    if (state === "APPROVAL_NEEDED") {
      const ap = await asApi(() =>
        call<{ runId?: string; approvals?: Array<Obj> }>(e.api, e.user, "GET", `/v1/runs/${runId}/approvals`),
      );
      const pending = (ap.body.approvals ?? []).filter((a) => a.status === "pending");
      const foreign = ap.body.runId !== runId;
      const bad = foreign
        ? pending[0]
        : pending.find((a) => !(a.kind === "canvas.apply_patch" && a.costLimit === 0));
      if (bad) {
        const kind = str(bad.kind) ?? "unknown";
        const limit = typeof bad.costLimit === "number" ? String(bad.costLimit) : null;
        return {
          kind: "waiting",
          progress: `Waiting for your decision on ${kind}`,
          waiting: {
            kind: "approval",
            runId,
            approvalId: String(bad.approvalId),
            approvalKind: kind,
            summary: foreign
              ? "This approval does not belong to the run the agent started."
              : `The agent only approves a canvas patch that costs nothing. This is ${kind} with a cost limit of ${limit ?? "not set"}.`,
            costLimit: limit,
          },
        };
      }
      for (const a of pending) {
        await call(
          e.api,
          e.user,
          "POST",
          `/v1/runs/${runId}/approvals/${String(a.approvalId)}`,
          { decision: "approve", actionHash: String(a.actionHash) },
          idem(e, `a${String(a.approvalId)}`),
        );
        await e.progress("Approved the canvas patch (cost limit 0)");
      }
    } else if (state === "COMPLETE") {
      const interp = run.interpretation?.state ?? "none";
      if (interp === "ready" || interp === "unavailable" || interp === "failed") {
        await recordRunCost(e, runId, run);
        const n = (run.findings ?? []).length;
        return {
          kind: "done",
          result: {
            summary:
              interp === "ready"
                ? `The run is complete with ${n} written finding${n === 1 ? "" : "s"}.`
                : `The run is complete, but its findings could not be written${run.interpretation?.reason ? `: ${run.interpretation.reason}` : ""}.`,
            items: [
              item("Run", runId, ws ? `/w/${ws}/investigate?run=${runId}` : null),
              item("Findings", String(n)),
            ],
          },
        };
      }
      completeSeen ??= e.now();
      if (e.now() - completeSeen > e.limits.interpretationGraceMs) {
        await recordRunCost(e, runId, run);
        return {
          kind: "done",
          result: {
            summary: "The run is complete. No findings were reported for it.",
            items: [item("Run", runId, ws ? `/w/${ws}/investigate?run=${runId}` : null)],
          },
        };
      }
    }
    if (elapsed > e.limits.runTimeoutMs)
      throw new StepFail(
        "RUN_TIMEOUT",
        `The run is still ${state.toLowerCase().replace(/_/g, " ")} after ${Math.round(e.limits.runTimeoutMs / 60_000)} minutes.`,
        true,
      );
    await e.sleep(e.limits.pollMs(elapsed));
  }
}

/** Newest COMPLETE run of the workspace, used when a step names no run and the task created none. */
async function latestRunId(e: Env, ws: string): Promise<string | null> {
  const r = await call<{ runs?: { runId?: string; state?: string }[] }>(
    e.api,
    e.user,
    "GET",
    `/v1/workspaces/${ws}/runs`,
  );
  const hit = (r.body.runs ?? []).find((x) => x.state === "COMPLETE" && typeof x.runId === "string");
  return hit?.runId ?? null;
}

/** Newest capsule of the workspace, used when a step names no capsule and the task built none. */
async function latestCapsuleId(e: Env): Promise<string | null> {
  const ws = e.ctx.workspaceId;
  if (!ws) return null;
  const r = await call<{ capsules?: { capsuleId?: string; createdAt?: string }[] }>(
    e.api,
    e.user,
    "GET",
    `/v1/workspaces/${ws}/capsules`,
  );
  const list = (r.body.capsules ?? []).filter((c) => typeof c.capsuleId === "string");
  list.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return list[0]?.capsuleId ?? null;
}

async function setupAuto(e: Env): Promise<Outcome> {
  const ws = wsOf(e);
  const runId = need(str(e.params.runId) ?? e.ctx.runId ?? (await latestRunId(e, ws)), "a finished run");
  const r = await call<{
    markers?: Obj[];
    monitors?: Obj[];
    hypothesis?: Obj | null;
    skipped?: Obj[];
    cost?: { usd?: number; modelCalls?: number };
  }>(e.api, e.user, "POST", `/v1/workspaces/${ws}/assistant/setup`, { runId }, idem(e));
  const b = r.body;
  if (b.hypothesis && typeof b.hypothesis.id === "string")
    await e.patchCtx({ hypothesisId: b.hypothesis.id });
  if (typeof b.cost?.usd === "number" && b.cost.usd > 0)
    await e.cost({
      label: "Setup (model spend)",
      unit: "usd",
      amount: b.cost.usd.toFixed(6),
      calls: b.cost.modelCalls ?? 0,
      sourceKey: `step:${e.taskId}:${e.idx}:model`,
    });
  const items: StepResultItem[] = [
    ...(b.markers ?? []).map((m) => item("Marker", String(m.title), `/w/${ws}/markers`)),
    ...(b.monitors ?? []).map((m) => item("Monitor", String(m.title), `/w/${ws}/monitors`)),
    ...(b.hypothesis ? [item("Draft hypothesis", String(b.hypothesis.title), `/w/${ws}/hypotheses`)] : []),
    ...(b.skipped ?? []).map((s) => item(`Skipped ${String(s.kind)}`, String(s.reason))),
  ];
  const made = (b.markers?.length ?? 0) + (b.monitors?.length ?? 0) + (b.hypothesis ? 1 : 0);
  return {
    kind: "done",
    result: {
      summary: `${made} created${(b.skipped?.length ?? 0) > 0 ? `, ${b.skipped!.length} skipped with a reason` : ""}.`,
      items,
    },
  };
}

async function markerCreate(e: Env): Promise<Outcome> {
  const ws = wsOf(e);
  const markerId = uuidFrom(`agent:${e.taskId}:${e.idx}:marker`);
  await call(e.api, e.user, "POST", `/v1/workspaces/${ws}/markers`, {
    markerId,
    panelId: e.params.panelId,
    anchor: { kind: "time_point", at: e.params.at },
    ...(e.params.question ? { question: e.params.question } : {}),
  });
  return {
    kind: "done",
    result: { summary: "Marker created.", items: [item("Marker", markerId, `/w/${ws}/markers`)] },
  };
}

async function monitorCreate(e: Env): Promise<Outcome> {
  const ws = wsOf(e);
  const w = await call<Obj>(e.api, e.user, "GET", `/v1/workspaces/${ws}`);
  const ruleId = uuidFrom(`agent:${e.taskId}:${e.idx}:rule`);
  await call(e.api, e.user, "POST", `/v1/workspaces/${ws}/commands`, {
    apiVersion: "v1",
    commandId: uuidFrom(`agent:${e.taskId}:${e.idx}:cmd`),
    commandType: "monitor.rule_create",
    payload: {
      ruleId,
      name: e.params.name,
      sourceId: e.params.sourceId,
      condition: { kind: "compare", metricId: e.params.metricId, op: e.params.op, value: e.params.value },
      dataMaturity: "finalized_only",
      frequency: { minIntervalSeconds: 0 },
      debounceSeconds: 0,
      cooldownSeconds: 86_400,
      action: "notify",
      enabled: true,
    },
    expectedVersion: Number(w.body.version ?? 0),
  });
  return {
    kind: "done",
    result: {
      summary: "Monitor rule created.",
      items: [item("Monitor", String(e.params.name), `/w/${ws}/monitors`)],
    },
  };
}

async function hypothesisCreate(e: Env): Promise<Outcome> {
  const ws = wsOf(e);
  const r = await call<Obj>(e.api, e.user, "POST", `/v1/workspaces/${ws}/hypotheses`, e.params);
  const id = need(str(r.body.hypothesisId), "the hypothesis id");
  await e.patchCtx({ hypothesisId: id });
  return {
    kind: "done",
    result: {
      summary: "Draft hypothesis created (not frozen).",
      items: [item("Hypothesis", String(e.params.proposition).slice(0, 140), `/w/${ws}/hypotheses`)],
    },
  };
}

async function hypothesisFreeze(e: Env): Promise<Outcome> {
  const ws = wsOf(e);
  const id = need(str(e.params.hypothesisId) ?? e.ctx.hypothesisId ?? null, "a hypothesis");
  await call(e.api, e.user, "POST", `/v1/workspaces/${ws}/hypotheses/${id}/freeze`, {});
  return {
    kind: "done",
    result: { summary: "Hypothesis frozen.", items: [item("Hypothesis", id, `/w/${ws}/hypotheses`)] },
  };
}

async function capsuleBuild(e: Env): Promise<Outcome> {
  const ws = wsOf(e);
  const runId = need(str(e.params.runId) ?? e.ctx.runId ?? (await latestRunId(e, ws)), "a finished run");
  const r = await call<Obj>(e.api, e.user, "POST", `/v1/workspaces/${ws}/capsules`, { runId }, idem(e));
  const capsuleId = need(str(r.body.capsuleId), "the capsule id");
  await e.patchCtx({ capsuleId });
  return {
    kind: "done",
    result: {
      summary: `Capsule built${str(r.body.title) ? `: ${str(r.body.title)}` : ""}.`,
      items: [
        item("Capsule", str(r.body.label) ?? capsuleId, `/w/${ws}/capsules/${capsuleId}`),
        ...(str(r.body.capsuleHash) ? [item("Hash", String(r.body.capsuleHash))] : []),
      ],
    },
  };
}

interface ProofView {
  proofId?: string;
  state?: string;
  error?: string | null;
  job?: { txHash?: string | null; explorerUrl?: string | null; requestId?: string | null };
  cost?: { heldYocto?: string | null; chargedYocto?: string | null; totalYocto?: string | null };
}
interface CreditEntryRow {
  id: string;
  kind: string;
  amountYocto: string;
  refKind: string | null;
  refId: string | null;
  detail?: Obj;
  createdAt?: string;
}
const creditEntries = async (e: Env): Promise<CreditEntryRow[]> =>
  (await call<{ entries?: CreditEntryRow[] }>(e.api, e.user, "GET", "/v1/credits")).body.entries ?? [];

async function recordProofCosts(e: Env, proofId: string, proof: ProofView): Promise<void> {
  let n = 0;
  for (const c of await creditEntries(e)) {
    if (c.refKind !== "proof" || c.refId !== proofId || c.kind !== "charge") continue;
    const d = c.detail ?? {};
    const parts = [
      typeof d.chargedYocto === "string" ? `deposit ${d.chargedYocto}` : null,
      typeof d.tokensBurntYocto === "string" ? `gas ${d.tokensBurntYocto}` : null,
    ].filter(Boolean);
    await e.cost({
      label: `OutLayer proof${parts.length ? ` (${parts.join(", ")} yoctoNEAR)` : ""}`,
      unit: "yoctoNEAR",
      amount: c.amountYocto,
      txHash: str(d.txHash) ?? proof.job?.txHash ?? null,
      sourceKey: `credit:${c.id}`,
    });
    n++;
  }
  const total = proof.cost?.totalYocto;
  if (n === 0 && typeof total === "string" && /^\d+$/.test(total) && total !== "0")
    await e.cost({
      label: "OutLayer proof",
      unit: "yoctoNEAR",
      amount: total,
      txHash: proof.job?.txHash ?? null,
      sourceKey: `proof:${proofId}:total`,
    });
  await e.setHeld("0");
}

/** Polls a proof until it leaves `running`, keeping the step's progress line and the held credits current. */
export async function awaitProof(e: Env, proofId: string): Promise<ProofView> {
  const began = e.now();
  for (;;) {
    const p = (await asApi(() => call<ProofView>(e.api, e.user, "GET", `/v1/proofs/${proofId}`))).body;
    if (p.state !== "running") return p;
    if (typeof p.cost?.heldYocto === "string" && /^\d+$/.test(p.cost.heldYocto))
      await e.setHeld(p.cost.heldYocto);
    await e.progress(`OutLayer job running (${Math.round((e.now() - began) / 1000)} s)`);
    if (await e.cancelled()) throw new StepFail("CANCELLED", "The task was cancelled.", false);
    if (e.now() - began > e.limits.proofTimeoutMs)
      throw new StepFail(
        "PROOF_TIMEOUT",
        "The OutLayer job is still running; its credits stay held until it settles. Retry to keep waiting.",
        true,
      );
    await e.sleep(3000);
  }
}
export { recordProofCosts };

async function capsuleProve(e: Env): Promise<Outcome> {
  const capsuleId = need(
    str(e.params.capsuleId) ?? e.ctx.capsuleId ?? (await latestCapsuleId(e)),
    "a capsule",
  );
  let proofId: string | null = null;
  // A proof this task already started is resumed, never paid for twice.
  if (e.ctx.proofId) {
    const r = await e.api(e.user, "GET", `/v1/proofs/${e.ctx.proofId}`);
    const st = (r.body as ProofView | null)?.state;
    if (r.status === 200 && (st === "running" || st === "verified")) proofId = e.ctx.proofId;
  }
  if (!proofId) {
    const r = await e.api(
      e.user,
      "POST",
      `/v1/capsules/${capsuleId}/proofs`,
      {},
      idem(e, e.attempt > 0 ? `p${e.attempt}` : undefined),
    );
    if (r.status === 409 && (r.body as Obj | null)?.reasonCode === "ALREADY_PROVED") {
      const list = await call<{ items?: ProofView[] }>(
        e.api,
        e.user,
        "GET",
        `/v1/capsules/${capsuleId}/proofs`,
      );
      const done = (list.body.items ?? []).find((p) => p.state === "verified");
      return {
        kind: "done",
        result: {
          summary: "The capsule already had a verified OutLayer proof; nothing was charged.",
          items: done?.proofId ? [item("Proof", done.proofId)] : [],
        },
      };
    }
    if (r.status < 200 || r.status >= 300)
      throw new StepFail(apiErrorOf(r).reasonCode, apiErrorOf(r).message, apiErrorOf(r).retryable);
    proofId = need(str((r.body as Obj).proofId), "the proof id");
    await e.patchCtx({ proofId });
  }
  const proof = await awaitProof(e, proofId);
  await recordProofCosts(e, proofId, proof);
  const items = [
    item("Proof", proofId),
    ...(proof.job?.txHash ? [item("Transaction", proof.job.txHash, proof.job.explorerUrl ?? null)] : []),
    ...(proof.cost?.totalYocto ? [item("Charged (yoctoNEAR)", proof.cost.totalYocto)] : []),
  ];
  if (proof.state === "verified")
    return { kind: "done", result: { summary: "The capsule is verified on OutLayer (testnet).", items } };
  throw new StepFail(
    `PROOF_${String(proof.state ?? "failed").toUpperCase()}`,
    proof.error ?? `The OutLayer proof ended as ${String(proof.state)}.`,
    proof.state === "failed",
  );
}

async function capsulePublish(e: Env): Promise<Outcome> {
  const capsuleId = need(
    str(e.params.capsuleId) ?? e.ctx.capsuleId ?? (await latestCapsuleId(e)),
    "a capsule",
  );
  const ack = Array.isArray(e.params.acknowledge) ? (e.params.acknowledge as string[]) : [];
  const t0 = e.startedAtMs;
  const r = await call<Obj>(
    e.api,
    e.user,
    "POST",
    `/v1/capsules/${capsuleId}/publish`,
    { acknowledge: ack },
    idem(e),
  );
  const publicationId = str(r.body.publicationId) ?? str(r.body.id);
  if (publicationId) await e.patchCtx({ publicationId });
  // Anchor gas: charged from the user's credits, read back from the ledger entries of this publication.
  const deadline = e.now() + e.limits.settleWaitMs;
  for (;;) {
    const entries = (await creditEntries(e)).filter(
      (c) => c.refKind === "publication" && (c.createdAt ? Date.parse(c.createdAt) >= t0 - 1000 : true),
    );
    for (const c of entries.filter((x) => x.kind === "charge"))
      await e.cost({
        label: "Publication anchor gas",
        unit: "yoctoNEAR",
        amount: c.amountYocto,
        txHash: str(c.detail?.txHash),
        sourceKey: `credit:${c.id}`,
      });
    const unsettled = entries.some(
      (h) =>
        h.kind === "hold" &&
        !entries.some((s) => s.refId === h.refId && (s.kind === "charge" || s.kind === "release")),
    );
    if (!unsettled || e.now() > deadline) break;
    await e.progress("Waiting for the anchor gas to settle");
    await e.sleep(3000);
  }
  return {
    kind: "done",
    result: {
      summary: "The capsule is published.",
      items: [
        item(
          "Capsule",
          capsuleId,
          e.ctx.workspaceId ? `/w/${e.ctx.workspaceId}/capsules/${capsuleId}` : null,
        ),
        ...(publicationId ? [item("Publication", publicationId, "/publications")] : []),
        item("Public page", "Open the public page", `/public/${capsuleId}`),
      ],
    },
  };
}

async function reportBuild(e: Env): Promise<Outcome> {
  const ws = str(e.params.workspaceId) ?? wsOf(e);
  await call(e.api, e.user, "GET", `/v1/workspaces/${ws}/report`);
  const reportUrl = `/w/${ws}/report`;
  await e.patchCtx({ reportUrl });
  return {
    kind: "done",
    result: {
      summary: "The workspace report is ready.",
      items: [
        item("Report", "Open the report", reportUrl),
        item("PDF", "Download the PDF", `/api/report/${ws}/pdf`),
      ],
    },
  };
}

export const HANDLERS: Record<string, (e: Env) => Promise<Outcome>> = {
  "workspace.create": workspaceCreate,
  "workspace.use": workspaceUse,
  "workspace.archive": workspaceArchive,
  "question.ask": questionAsk,
  "run.await": runAwait,
  "setup.auto": setupAuto,
  "marker.create": markerCreate,
  "monitor.create": monitorCreate,
  "hypothesis.create": hypothesisCreate,
  "hypothesis.freeze": hypothesisFreeze,
  "capsule.build": capsuleBuild,
  "capsule.prove": capsuleProve,
  "capsule.publish": capsulePublish,
  "report.build": reportBuild,
};
