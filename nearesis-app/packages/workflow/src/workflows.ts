/**
 * Deterministic workflow code: no I/O, no Date.now(), no Math.random(). Network/DB/model calls are activities.
 * Imports are limited to @temporalio/workflow, ./pure.ts (pure-JS sha256/canonical JSON) and the contracts transition table.
 */
import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  patched,
  proxyActivities,
  setHandler,
  sleep,
  startChild,
  workflowInfo,
  type ChildWorkflowHandle,
} from "@temporalio/workflow";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import { RUN_TRANSITIONS, type RunState } from "@nearesis/contracts";
import type { Activities } from "./activities.ts";
import type { ComputedInterpretation } from "./interpretation.ts";
import { childWorkflowId, privilegedActionHash, type DedupKey } from "./pure.ts";
import type {
  ChildInput,
  ChildOutcome,
  ChildSpec,
  InvestigationInput,
  InvestigationResult,
  RunContext,
  RunFailureView,
} from "./types.ts";

export const approveSignal = defineSignal<[{ actionHash: string; approvedBy: string }]>("approve");
export const rejectSignal = defineSignal<[{ actionHash?: string; rejectedBy: string }]>("reject");
export const cancelSignal = defineSignal<[{ requestedBy?: string }?]>("cancel");
/** Replaces the pending privileged action's parameters; earlier approvals become invalid (A07). */
export const modifyActionSignal = defineSignal<[{ params: Record<string, unknown> }]>("modifyAction");
export const stateQuery = defineQuery<string>("state");

const NON_RETRYABLE = [
  "DEPTH_LIMIT",
  "FANOUT_LIMIT",
  "TOOL_CALL_BUDGET",
  "STAGE_TIMEOUT",
  "TOOL_NOT_GRANTED",
  "APPROVAL_INVALID",
  "BUDGET_EXCEEDED",
  "CAPABILITY_ESCALATION",
  "ILLEGAL_TRANSITION",
  "CONTEXT_MISMATCH",
];

const quick = proxyActivities<Activities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "300 milliseconds",
    maximumInterval: "5 seconds",
    maximumAttempts: 8,
    nonRetryableErrorTypes: NON_RETRYABLE,
  },
});

/** Interpretation reads panel results and makes up to two model calls: one attempt, a bounded wait, no retry storm. */
const interpret = proxyActivities<Activities>({
  startToCloseTimeout: "270 seconds",
  heartbeatTimeout: "60 seconds",
  cancellationType: "WAIT_CANCELLATION_COMPLETED",
  retry: { maximumAttempts: 1 },
});

function messageOf(err: unknown): string {
  let e: unknown = err;
  let last = "";
  for (let i = 0; i < 6 && e; i++) {
    last = (e as { message?: string }).message ?? last;
    e = (e as { cause?: unknown }).cause;
  }
  return last.slice(0, 500);
}

function reasonOf(err: unknown): string {
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i++) {
    if (e instanceof ApplicationFailure && e.type) return e.type;
    e = (e as { cause?: unknown }).cause;
  }
  return "INTERNAL";
}

const stopSpawning = (outs: ChildOutcome[]): boolean =>
  outs.some(
    (o) =>
      (o.result as { finding?: { status?: string } | null } | null)?.finding?.status === "cannot_compute",
  );

function failureFor(
  reasonCode: string,
  workflowId: string,
  lastCheckpoint: string | null,
  detail?: string,
): RunFailureView {
  const human = new Set(["CANNOT_COMPUTE", "APPROVAL_INVALID", "APPROVAL_REJECTED", "BUDGET_EXCEEDED"]);
  const retry = new Set(["SOURCE_UNAVAILABLE", "STAGE_TIMEOUT", "INTERNAL"]);
  return {
    reasonCode,
    retryability: human.has(reasonCode)
      ? "human_action_needed"
      : retry.has(reasonCode)
        ? "retryable"
        : "not_retryable",
    humanActionNeeded: human.has(reasonCode)
      ? (detail ??
        `Resolve ${reasonCode} (add the missing metric/permission, adjust budget, or re-approve) and rerun`)
      : null,
    lastCheckpoint,
    replayCommand: `pnpm --filter @nearesis/workflow replay -- --workflow-id ${workflowId}`,
  };
}

export async function InvestigationWorkflow(input: InvestigationInput): Promise<InvestigationResult> {
  const wfId = workflowInfo().workflowId;
  const { tenantId, runId, workspaceId } = input;
  let state: RunState = "REQUESTED";
  let seq = 0;
  let cancelRequested = false;
  const approvals: Array<{ actionHash: string; approvedBy: string }> = [];
  const rejections: Array<{ actionHash?: string; rejectedBy: string }> = [];
  let currentAction: {
    kind: string;
    params: Record<string, unknown>;
    network: string;
    costLimit: number;
  } | null = null;
  let actionVersion = 0;
  let invalidationNoted = false;
  let spawnCount = 0;
  const childTaskIds: string[] = [];
  const childPromises: Promise<unknown>[] = [];
  let approvalHash: string | null = null;

  const scope = new CancellationScope({ cancellable: true });
  setHandler(cancelSignal, () => {
    if (!cancelRequested) {
      cancelRequested = true;
      scope.cancel();
    }
  });
  setHandler(approveSignal, (a) => void approvals.push(a));
  setHandler(rejectSignal, (r) => void rejections.push(r));
  setHandler(modifyActionSignal, (m) => {
    if (currentAction) {
      currentAction = { ...currentAction, params: m.params };
      actionVersion++;
    }
  });
  setHandler(stateQuery, () => state);

  const note = (kind: string, detail: Record<string, unknown> = {}) =>
    quick.recordRunEvent({ tenantId, runId, source: "run", seq: ++seq, kind, detail });
  async function transition(to: RunState, detail: Record<string, unknown> = {}, failure?: RunFailureView) {
    if (!RUN_TRANSITIONS[state].includes(to))
      throw ApplicationFailure.nonRetryable(`illegal transition ${state} -> ${to}`, "ILLEGAL_TRANSITION");
    await quick.recordRunEvent({
      tenantId,
      runId,
      source: "run",
      seq: ++seq,
      kind: "transition",
      from: state,
      to,
      detail,
      ...(failure ? { failure } : {}),
    });
    state = to;
  }
  const result = (
    failure: RunFailureView | null,
    failedBranches: InvestigationResult["failedBranches"] = [],
  ): InvestigationResult => ({
    runId,
    state,
    failure,
    failedBranches,
    childTaskIds,
    spawnCount,
    approvalActionHash: approvalHash,
  });

  try {
    return await scope.run(async () => {
      const { directorTaskId } = await quick.initRun({ ...input, workflowId: wfId });
      await note("run.requested", { directorTaskId });
      const policy = await quick.loadPolicy();
      const heavy = proxyActivities<Activities>({
        startToCloseTimeout: policy.stageTimeboxMs + 60_000,
        heartbeatTimeout: policy.heartbeatTimeoutMs,
        cancellationType: "WAIT_CANCELLATION_COMPLETED",
        retry: {
          initialInterval: "500 milliseconds",
          maximumInterval: "5 seconds",
          maximumAttempts: 20,
          nonRetryableErrorTypes: NON_RETRYABLE,
        },
      });

      await transition("PLANNING");
      let plan: Awaited<ReturnType<typeof quick.planTask>>;
      try {
        plan = await heavy.planTask({
          tenantId,
          workspaceId,
          runId,
          budgetId: input.budgetId,
          directorTaskId,
          question: `[scenario=${input.scenario ?? "none"}] ${input.question ?? "investigate"}`,
          ...(input.scenario ? { scenario: input.scenario } : {}),
        });
      } catch (e) {
        if (isCancellation(e)) throw e;
        const reason = reasonOf(e);
        await transition(
          "BLOCKED",
          { stage: "planning", error: messageOf(e) },
          failureFor(reason, wfId, `thread:${directorTaskId}`),
        );
        return result(failureFor(reason, wfId, `thread:${directorTaskId}`));
      }
      await note("plan.validated", { stages: plan.stages.length, missingMetrics: plan.missingMetrics });
      // Freeze the dispatch context and gate fresh-data runs on source health. `patched` keeps histories recorded before
      // this existed replayable (A13); new runs always take the new path.
      let runContext: RunContext | null = null;
      if (patched("run-context-1")) {
        runContext = await quick.bindRunContext({
          tenantId,
          workspaceId,
          runId,
          directorTaskId,
          question: input.question ?? "investigate",
          ...(input.preregistrationHash ? { preregistrationHash: input.preregistrationHash } : {}),
        });
        const gate = await quick.gateRun({ tenantId, runId, requiredMetrics: plan.requiredMetrics });
        if (gate.state === "BLOCKED_SOURCE") {
          const f = failureFor(gate.reasonCode ?? "SOURCE_UNAVAILABLE", wfId, `thread:${directorTaskId}`);
          await note("source.blocked", { reasonCode: gate.reasonCode, sources: gate.sources });
          await transition(
            "BLOCKED_SOURCE",
            { stage: "source_gate", reasonCode: gate.reasonCode, sources: gate.sources },
            { ...f, retryability: "retryable" },
          );
          return result({ ...f, retryability: "retryable" });
        }
      }
      await transition("EXECUTING", { children: plan.stages.reduce((n, s) => n + s.length, 0) });

      // ---- run stages; children of one stage run in parallel ----
      const outcomes: ChildOutcome[] = [];
      const handles = new Map<string, Promise<ChildOutcome>>();

      async function runChildWorkflow(
        spec: ChildSpec,
        taskId: string,
        depth: number,
        hypothesisId: string,
        key: DedupKey,
      ): Promise<ChildOutcome> {
        const id = childWorkflowId(key);
        const cin: ChildInput = {
          dedupKey: key,
          role: spec.role,
          objective: spec.objective,
          depth,
          parentRunId: runId,
          tenantId,
          workspaceId,
          budgetId: input.budgetId,
          taskId,
          hypothesisId,
          ...(input.grants ? { grants: input.grants } : {}),
          ...(runContext ? { context: runContext.hashes } : {}),
        };
        let handle: ChildWorkflowHandle<typeof ResearchChildWorkflow>;
        try {
          handle = await startChild(ResearchChildWorkflow, {
            workflowId: id,
            args: [cin],
            parentClosePolicy: "REQUEST_CANCEL",
            workflowIdReusePolicy: "REJECT_DUPLICATE",
          });
        } catch (e) {
          if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
          await note("child.duplicate_start", { childWorkflowId: id, taskId });
          const known = handles.get(id);
          if (known) return { ...(await known), deduplicated: true };
          return quick.awaitTaskOutcome({ tenantId, taskId, timeoutMs: policy.stageTimeboxMs * 2 });
        }
        await quick.recordChildStarted({
          tenantId,
          runId,
          taskId,
          childWorkflowId: id,
          ...(input.scenario ? { scenario: input.scenario } : {}),
        });
        const p = handle.result().catch((err): ChildOutcome => {
          if (isCancellation(err))
            return {
              taskId,
              role: spec.role,
              task: spec.task,
              status: "cancelled",
              reasonCode: "CANCELLED",
              result: null,
            };
          return {
            taskId,
            role: spec.role,
            task: spec.task,
            status: "failed",
            reasonCode: reasonOf(err),
            result: null,
          };
        });
        handles.set(id, p);
        childPromises.push(p);
        return p;
      }

      async function runStage(stage: ChildSpec[]): Promise<ChildOutcome[]> {
        const done = new Map<number, ChildOutcome>();
        const running = new Map<number, Promise<void>>();
        let pending = stage.map((_c, i) => i);
        while (pending.length || running.size) {
          const stillPending: number[] = [];
          for (const i of pending) {
            const spec = stage[i]!;
            const key: DedupKey = {
              workspaceId,
              investigationId: input.investigationId,
              task: spec.task,
              modelVersion: plan.modelVersion,
              inputSnapshot: spec.inputSnapshot,
            };
            let sp;
            try {
              sp = await quick.spawnTask({
                tenantId,
                workspaceId,
                runId,
                budgetId: input.budgetId,
                investigationId: input.investigationId,
                parentTaskId: directorTaskId,
                modelVersion: plan.modelVersion,
                child: runContext ? { ...spec, context: runContext.hashes } : spec,
                ...(input.grants ? { grants: input.grants } : {}),
              });
            } catch (e) {
              if (isCancellation(e)) throw e;
              const reason = reasonOf(e);
              if (reason === "FANOUT_LIMIT") {
                await note("spawn.queued", { task: spec.task, reason });
                stillPending.push(i);
                continue;
              }
              done.set(i, {
                taskId: "",
                role: spec.role,
                task: spec.task,
                status: "rejected",
                reasonCode: reason,
                result: null,
              });
              continue;
            }
            if (sp.created) spawnCount++;
            if (!childTaskIds.includes(sp.taskId)) childTaskIds.push(sp.taskId);
            const pr = runChildWorkflow(spec, sp.taskId, sp.depth, sp.hypothesisId, key).then(
              (o) => void done.set(i, o),
            );
            running.set(
              i,
              pr.finally(() => void running.delete(i)),
            );
          }
          pending = stillPending;
          if (running.size) await Promise.race([...running.values()]);
          else if (pending.length) await sleep("1 second");
        }
        return stage.map((_s, i) => done.get(i)!);
      }

      let abstained = false;
      for (const stage of plan.stages) {
        const outs = await runStage(stage);
        outcomes.push(...outs);
        if (stopSpawning(outs)) {
          abstained = true;
          await note("director.abstained", { spawnCount });
          break;
        }
      }

      // ---- privileged step (only when every branch produced a result) ----
      const anyFailed = outcomes.some((o) => o.status !== "finished");
      // Interpretation, first half (A37): the analyst and skeptic read the PREVIEWED panels (the ones the approval hash binds) while
      // the owner decides, so their model time overlaps the approval wait. Nothing is recorded or published until the patch is
      // approved and applied (interpretCommit below); a rejected, modified, failed or cancelled run drops the result unread.
      let speculation: Promise<ComputedInterpretation | null> | null = null;
      let speculationScope: CancellationScope | null = null;
      const dropSpeculation = () => speculationScope?.cancel();
      if (
        plan.privilegedAction &&
        !anyFailed &&
        !abstained &&
        outcomes.some((o) => o.role === "composer" && o.status === "finished") &&
        patched("interpretation-2")
      ) {
        const sc = new CancellationScope({ cancellable: true });
        speculationScope = sc;
        speculation = sc
          .run(() =>
            interpret.interpretCompute({
              tenantId,
              workspaceId,
              runId,
              budgetId: input.budgetId,
              directorTaskId,
              question: input.question ?? "investigate",
            }),
          )
          .catch(() => null);
      }
      if (plan.privilegedAction && !anyFailed && !abstained) {
        currentAction = plan.privilegedAction;
        // live composer: the approved action must carry the exact verified patch
        if (currentAction.params.fromComposer === true)
          currentAction = await quick.bindComposerAction({ tenantId, runId, action: currentAction });
        await transition("APPROVAL_NEEDED", { actionHash: privilegedActionHash(currentAction) });
        await note("approval.requested", {
          actionHash: privilegedActionHash(currentAction),
          kind: currentAction.kind,
          network: currentAction.network,
          costLimit: currentAction.costLimit,
        });
        const decided = () => {
          const h = privilegedActionHash(currentAction!);
          return (
            approvals.some((a) => a.actionHash === h) ||
            rejections.some((r) => r.actionHash === undefined || r.actionHash === h)
          );
        };
        let seenVersion = actionVersion;
        const deadlineHit = !(await condition(
          () => decided() || actionVersion !== seenVersion,
          policy.approvalTimeoutMs,
        ));
        // re-evaluate after any modification: modified params => new hash => old approvals no longer count
        for (let guard = 0; !deadlineHit && !decided() && guard < 50; guard++) {
          invalidationNoted = true;
          await note("approval.invalidated", {
            newActionHash: privilegedActionHash(currentAction),
            staleApprovals: approvals.length,
          });
          seenVersion = actionVersion;
          if (!(await condition(() => decided() || actionVersion !== seenVersion, policy.approvalTimeoutMs)))
            break;
        }
        const h = privilegedActionHash(currentAction);
        const ap = approvals.find((a) => a.actionHash === h);
        const rj = rejections.find((r) => r.actionHash === undefined || r.actionHash === h);
        approvalHash = h;
        if (actionVersion > 0 && !ap && approvals.length > 0 && !invalidationNoted)
          await note("approval.invalidated", {
            newActionHash: h,
            staleApprovals: approvals.filter((a) => a.actionHash !== h).length,
          });
        if (rj && !ap) {
          await quick.recordApproval({
            tenantId,
            runId,
            actionHash: h,
            decision: "reject",
            by: rj.rejectedBy,
            network: currentAction.network,
            costLimit: currentAction.costLimit,
            ttlMs: 1000,
          });
          const f = failureFor("APPROVAL_REJECTED", wfId, `event:${seq}`);
          dropSpeculation();
          await transition("BLOCKED", { actionHash: h }, f);
          return result(f);
        }
        if (!ap) {
          const f = failureFor(
            "APPROVAL_INVALID",
            wfId,
            `event:${seq}`,
            "No approval matches the current action hash; re-approve the exact parameters",
          );
          await note("approval.mismatch", {
            currentActionHash: h,
            presented: approvals.map((a) => a.actionHash),
          });
          dropSpeculation();
          await transition("BLOCKED", { actionHash: h }, f);
          return result(f);
        }
        await quick.recordApproval({
          tenantId,
          runId,
          actionHash: h,
          decision: "approve",
          by: ap.approvedBy,
          network: currentAction.network,
          costLimit: currentAction.costLimit,
          ttlMs: 24 * 3600_000,
        });
        await transition("EXECUTING", { approvedBy: ap.approvedBy, actionHash: h });
        try {
          await heavy.executePrivilegedAction({
            tenantId,
            workspaceId,
            runId,
            directorTaskId,
            action: currentAction,
            actionHash: h,
          });
        } catch (e) {
          if (isCancellation(e)) throw e;
          const f = failureFor(reasonOf(e), wfId, `event:${seq}`);
          dropSpeculation();
          await transition("BLOCKED", {}, f);
          return result(f);
        }
        await note("privileged.executed", { actionHash: h });
      }

      // ---- evidence review and terminal state ----
      await transition("EVIDENCE_REVIEW");
      const verdict = await heavy.reviewEvidence({ tenantId, workspaceId, runId, outcomes });
      if (verdict.outcome !== "COMPLETE") dropSpeculation();
      if (verdict.outcome === "COMPLETE") {
        const composed = outcomes.some((o) => o.role === "composer" && o.status === "finished");
        if (composed) {
          await transition("CANVAS_PATCH_REVIEW");
          const cp = await quick.reviewCanvasPatch({ tenantId, runId });
          await note("canvas_patch.reviewed", { proposals: cp.proposals });
        }
        // Interpretation (A28): read what the approved panels show. Best effort by construction: it never fails the run.
        if (composed && patched("interpretation-1")) {
          try {
            const iargs = {
              tenantId,
              workspaceId,
              runId,
              budgetId: input.budgetId,
              directorTaskId,
              question: input.question ?? "investigate",
            };
            // A modified action no longer matches the previewed panels: its speculation is discarded and the full stage runs.
            if (actionVersion > 0) dropSpeculation();
            const early = speculation && actionVersion === 0 ? await speculation : null;
            const it = early
              ? await quick.interpretCommit({ ...iargs, computed: early })
              : await interpret.interpretRun(iargs);
            await note("interpretation.finished", {
              state: it.state,
              reason: it.reason,
              findings: it.findingCount,
              ...(it.timings ? { timings: it.timings } : {}),
            });
          } catch (e) {
            if (isCancellation(e)) throw e;
            await note("interpretation.finished", { state: "unavailable", reason: reasonOf(e), findings: 0 });
          }
        }
        await transition("COMPLETE");
        return result(null);
      }
      const firstFailed = verdict.failedBranches[0];
      const reason = abstained ? "CANNOT_COMPUTE" : (firstFailed?.reasonCode ?? "PARTIAL");
      const detail = abstained ? verdict.notes.join("; ") : undefined;
      const f = failureFor(reason, wfId, `thread:${directorTaskId}`, detail);
      await transition(verdict.outcome, { failedBranches: verdict.failedBranches }, f);
      return result(f, verdict.failedBranches);
    });
  } catch (err) {
    if (!isCancellation(err) && !cancelRequested) throw err;
    // A10: cancellation. Children were sent cancellation by the scope; settle, reconcile in-flight external calls, stable parent state.
    return await CancellationScope.nonCancellable(async () => {
      await Promise.allSettled(childPromises); // children acknowledge cancellation and record CANCELLED
      const rec = await quick.reconcileCancellation({ tenantId, runId });
      const f = failureFor("CANCELLED", wfId, `event:${seq}`);
      const from = state;
      if (RUN_TRANSITIONS[from].includes("CANCELLED")) {
        await transition(
          "CANCELLED",
          { inFlightExternalCalls: rec.inFlight, cancelledTasks: rec.cancelledTasks },
          f,
        );
      }
      return result(f);
    });
  }
}

export async function ResearchChildWorkflow(input: ChildInput): Promise<ChildOutcome> {
  const policy = await quick.loadPolicy();
  const heavy = proxyActivities<Activities>({
    startToCloseTimeout: policy.stageTimeboxMs + 60_000,
    heartbeatTimeout: policy.heartbeatTimeoutMs,
    cancellationType: "WAIT_CANCELLATION_COMPLETED",
    retry: {
      initialInterval: "500 milliseconds",
      maximumInterval: "5 seconds",
      maximumAttempts: 20,
      nonRetryableErrorTypes: NON_RETRYABLE,
    },
  });
  const base = {
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    runId: input.parentRunId,
    budgetId: input.budgetId,
    taskId: input.taskId,
  };
  const taskName = input.dedupKey.task;
  let outcome: ChildOutcome = {
    taskId: input.taskId,
    role: input.role,
    task: taskName,
    status: "failed",
    reasonCode: "INTERNAL",
    result: null,
  };
  try {
    const rr = await heavy.runRoleTask({
      ...base,
      role: input.role,
      objective: input.objective,
      hypothesisId: input.hypothesisId,
    });
    outcome = {
      taskId: input.taskId,
      role: input.role,
      task: taskName,
      status: rr.status === "finished" ? "finished" : "failed",
      reasonCode: rr.reasonCode,
      result: rr as unknown as Record<string, unknown>,
    };
    if (rr.status === "finished")
      await quick.persistArtifact({
        tenantId: input.tenantId,
        runId: input.parentRunId,
        taskId: input.taskId,
        artifactSha256: rr.artifact.sha256,
      });

    // delegation requests (director-role only; the supervisor enforces depth, fan-out, subset, budget)
    const subs: Promise<ChildOutcome>[] = [];
    for (const req of rr.spawnRequests) {
      try {
        const sp = await quick.spawnTask({
          ...base,
          investigationId: input.dedupKey.investigationId,
          parentTaskId: input.taskId,
          modelVersion: input.dedupKey.modelVersion,
          child: input.context ? { ...req, context: input.context } : req,
          ...(input.grants ? { grants: input.grants } : {}),
        });
        const key: DedupKey = {
          workspaceId: input.workspaceId,
          investigationId: input.dedupKey.investigationId,
          task: req.task,
          modelVersion: input.dedupKey.modelVersion,
          inputSnapshot: req.inputSnapshot,
        };
        const cin: ChildInput = {
          ...input,
          dedupKey: key,
          role: req.role,
          objective: req.objective,
          depth: sp.depth,
          taskId: sp.taskId,
          hypothesisId: sp.hypothesisId,
        };
        const h = await startChild(ResearchChildWorkflow, {
          workflowId: childWorkflowId(key),
          args: [cin],
          parentClosePolicy: "REQUEST_CANCEL",
          workflowIdReusePolicy: "REJECT_DUPLICATE",
        }).catch(async (e: unknown) => {
          if (e instanceof WorkflowExecutionAlreadyStartedError) return null;
          throw e;
        });
        if (h) subs.push(h.result());
      } catch (e) {
        if (isCancellation(e)) throw e;
        // policy rejections (DEPTH_LIMIT, FANOUT_LIMIT, ...) are audited by the supervisor; the delegator carries on
      }
    }
    if (subs.length) await Promise.all(subs.map((p) => p.catch(() => null)));
  } catch (e) {
    if (isCancellation(e)) {
      await CancellationScope.nonCancellable(() =>
        quick.finishTask({
          ...base,
          status: "CANCELLED",
          outcome: { ...outcome, status: "cancelled", reasonCode: "CANCELLED" },
        }),
      );
      throw e;
    }
    const reason = reasonOf(e);
    outcome = {
      taskId: input.taskId,
      role: input.role,
      task: taskName,
      status: "failed",
      reasonCode: reason === "INTERNAL" ? "STAGE_TIMEOUT" : reason,
      result: null,
    };
  }
  await quick.finishTask({ ...base, status: outcome.status === "finished" ? "DONE" : "FAILED", outcome });
  return outcome;
}
