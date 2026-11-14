import { z } from "zod";
import { MIN_QUESTION_BUDGET } from "@nearesis/contracts";
import type { ConsentKey, ConsentRequirement, TaskCtx } from "./types.ts";

/**
 * The step catalog: the only things a plan may contain. Model output is untrusted, so a plan is accepted only if every step key
 * and every parameter validates here, and consent and estimates are computed from the validated steps, never from the model.
 */
const Uuid = z.uuid();
const IsoDateTime = z.iso.datetime();
const Text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const STEP_PARAMS = {
  "workspace.create": z.strictObject({ objective: Text(1, 2000) }),
  "workspace.use": z.strictObject({ workspaceId: Uuid }),
  "workspace.archive": z.strictObject({ workspaceId: Uuid.optional() }),
  "question.ask": z.strictObject({
    question: Text(1, 2000).optional(),
    source: z.enum(["live", "fixture"]).optional(),
  }),
  "run.await": z.strictObject({ runId: Uuid.optional() }),
  "setup.auto": z.strictObject({ runId: Uuid.optional() }),
  "marker.create": z.strictObject({ panelId: Uuid, at: IsoDateTime, question: Text(1, 2000).optional() }),
  "monitor.create": z.strictObject({
    name: Text(1, 200),
    sourceId: Text(1, 200),
    metricId: Text(1, 200),
    op: z.enum(["gt", "gte", "lt", "lte", "eq", "ne"]),
    value: z.number().finite(),
  }),
  "hypothesis.create": z.strictObject({
    proposition: Text(5, 4000),
    target: z.string().trim().max(2000).default(""),
    predictor: z.string().trim().max(2000).default(""),
    benchmark: z.string().trim().max(2000).default(""),
    falsification: Text(1, 4000),
  }),
  "hypothesis.freeze": z.strictObject({ hypothesisId: Uuid.optional() }),
  "capsule.build": z.strictObject({ runId: Uuid.optional() }),
  "capsule.prove": z.strictObject({ capsuleId: Text(1, 200).optional() }),
  "capsule.publish": z.strictObject({
    capsuleId: Text(1, 200).optional(),
    acknowledge: z.array(Text(1, 100)).max(20).optional(),
  }),
  "report.build": z.strictObject({ workspaceId: Uuid.optional() }),
} as const;
export type StepKey = keyof typeof STEP_PARAMS;
export const STEP_KEYS = Object.keys(STEP_PARAMS) as StepKey[];
export const isStepKey = (k: string): k is StepKey => Object.hasOwn(STEP_PARAMS, k);

export const STEP_CONSENT: Partial<Record<StepKey, ConsentKey[]>> = {
  "workspace.archive": ["archive_workspace"],
  "hypothesis.freeze": ["freeze_hypothesis"],
  "capsule.prove": ["spend_credits"],
  "capsule.publish": ["publish_public", "spend_credits"],
};

/** What the planner is told about each key (the prompt documents parameters; validation is STEP_PARAMS). */
export const CATALOG_DOC: Record<StepKey, string> = {
  "workspace.create": 'create a workspace. params {"objective": string}',
  "workspace.use": 'bind an existing workspace (an id from <workspaces>). params {"workspaceId": uuid}',
  "workspace.archive":
    'archive a workspace (needs consent). params {"workspaceId"?: uuid} (default: the task workspace)',
  "question.ask":
    'start an investigation run. params {"question"?: string, "source"?: "live"|"fixture"} (default: the workspace objective, live)',
  "run.await":
    'wait for the run to finish (approves only the zero-cost canvas patch). params {"runId"?: uuid} (default: the run just asked)',
  "setup.auto":
    'create markers, monitor rules and a draft hypothesis from the finished run. params {"runId"?: uuid}',
  "marker.create":
    'create a marker on an existing panel. params {"panelId": uuid, "at": ISO datetime, "question"?: string}; only when the user supplied the panel id',
  "monitor.create":
    'create one monitor rule. params {"name", "sourceId", "metricId", "op": gt|gte|lt|lte|eq|ne, "value": number}; only when the user supplied the source and metric',
  "hypothesis.create":
    'create a DRAFT hypothesis. params {"proposition", "target"?, "predictor"?, "benchmark"?, "falsification"}',
  "hypothesis.freeze":
    'freeze a hypothesis (needs consent). params {"hypothesisId"?: uuid} (default: the one just created)',
  "capsule.build": 'build a verifiable capsule from the finished run. params {"runId"?: uuid}',
  "capsule.prove":
    'verify the capsule on OutLayer, paid from the user\'s credits (needs consent). params {"capsuleId"?: string}',
  "capsule.publish":
    'publish the capsule publicly (needs consent). params {"capsuleId"?: string, "acknowledge"?: string[]}',
  "report.build":
    'check the workspace report is ready and link the page and PDF. params {"workspaceId"?: uuid}',
};

export const PLAYBOOKS = [
  "investigate: workspace.create (or workspace.use), question.ask, run.await, setup.auto",
  "full publish: workspace.create|use, question.ask, run.await, capsule.build, capsule.prove, capsule.publish, report.build",
  "report only: report.build (on an existing workspace)",
  "single actions: one step on an existing workspace (for example hypothesis.create or workspace.archive)",
].join("\n");

export interface PlannedStep {
  key: StepKey;
  params: Record<string, unknown>;
}
export class PlanRejected extends Error {}

/** Parses and validates one step. Throws PlanRejected with a plain reason. */
export function validateStep(key: string, rawParams: unknown): PlannedStep {
  if (!isStepKey(key)) throw new PlanRejected(`The step "${key.slice(0, 60)}" is not something I can do.`);
  const r = STEP_PARAMS[key].safeParse(rawParams ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    throw new PlanRejected(
      `The parameters for ${key} are not valid${first ? ` (${first.path.join(".") || "params"}: ${first.message})` : ""}.`,
    );
  }
  return { key, params: r.data as Record<string, unknown> };
}

/** Which ids a step needs before it runs, and which it produces; used to refuse plans that cannot work. */
export function validateOrder(steps: PlannedStep[], ambient: TaskCtx): void {
  const have: TaskCtx = { ...ambient };
  const need = (cond: unknown, why: string) => {
    if (!cond) throw new PlanRejected(why);
  };
  steps.forEach((s, i) => {
    const p = s.params as Record<string, string | undefined>;
    const at = `Step ${i + 1} (${s.key})`;
    switch (s.key) {
      case "workspace.create":
        have.workspaceId = "<new>";
        delete have.runId;
        delete have.capsuleId;
        delete have.hypothesisId;
        break;
      case "workspace.use":
        have.workspaceId = p.workspaceId;
        break;
      case "workspace.archive":
        need(p.workspaceId || have.workspaceId, `${at} has no workspace to archive.`);
        break;
      case "question.ask":
        need(have.workspaceId, `${at} needs a workspace first.`);
        have.runId = "<new>";
        break;
      case "run.await":
        need(p.runId || have.runId, `${at} needs a run (ask a question first).`);
        if (p.runId) have.runId = p.runId;
        break;
      case "setup.auto":
      case "capsule.build":
        need(have.workspaceId, `${at} needs a workspace.`);
        // An existing workspace may already hold a finished run: the step then takes its newest COMPLETE run.
        need(p.runId || have.runId || have.workspaceId !== "<new>", `${at} needs a finished run.`);
        if (s.key === "capsule.build") have.capsuleId = "<new>";
        break;
      case "marker.create":
      case "monitor.create":
      case "hypothesis.create":
        need(have.workspaceId, `${at} needs a workspace first.`);
        if (s.key === "hypothesis.create") have.hypothesisId = "<new>";
        break;
      case "hypothesis.freeze":
        need(have.workspaceId, `${at} needs a workspace first.`);
        need(
          p.hypothesisId || have.hypothesisId,
          `${at} needs a hypothesis id or a hypothesis created earlier.`,
        );
        break;
      case "capsule.prove":
      case "capsule.publish":
        // An existing workspace may already hold a capsule: the step then takes its newest one.
        need(
          p.capsuleId || have.capsuleId || (have.workspaceId && have.workspaceId !== "<new>"),
          `${at} needs a capsule (build one first).`,
        );
        if (p.capsuleId) have.capsuleId = p.capsuleId;
        break;
      case "report.build":
        need(p.workspaceId || have.workspaceId, `${at} needs a workspace.`);
        break;
    }
  });
}

/** yoctoNEAR decimal string -> NEAR with up to 6 decimals, exact (truncated, never rounded up). */
export function nearOf(yocto: string): string {
  if (!/^\d+$/.test(yocto)) return "unknown";
  const v = BigInt(yocto);
  const whole = v / 10n ** 24n;
  const frac = ((v % 10n ** 24n) / 10n ** 18n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export const MAX_PLAN_STEPS = 12;

export function titleOf(step: PlannedStep): string {
  const p = step.params as Record<string, unknown>;
  switch (step.key) {
    case "workspace.create":
      return "Create the workspace";
    case "workspace.use":
      return "Use the existing workspace";
    case "workspace.archive":
      return "Archive the workspace";
    case "question.ask":
      return "Start the investigation";
    case "run.await":
      return "Run the investigation to completion";
    case "setup.auto":
      return "Add markers, monitors and a draft hypothesis";
    case "marker.create":
      return "Create a marker";
    case "monitor.create":
      return `Create the monitor "${String(p.name)}"`;
    case "hypothesis.create":
      return "Create a draft hypothesis";
    case "hypothesis.freeze":
      return "Freeze the hypothesis";
    case "capsule.build":
      return "Build the verifiable capsule";
    case "capsule.prove":
      return "Verify the capsule on OutLayer";
    case "capsule.publish":
      return "Publish the capsule";
    case "report.build":
      return "Prepare the workspace report";
  }
}

export function detailOf(step: PlannedStep): string {
  const p = step.params as Record<string, unknown>;
  const q = (v: unknown) => `"${String(v).slice(0, 160)}"`;
  switch (step.key) {
    case "workspace.create":
      return `Creates a workspace with the objective ${q(p.objective)}.`;
    case "workspace.use":
      return `Works in the existing workspace ${String(p.workspaceId)}.`;
    case "workspace.archive":
      return "Archives the workspace (it is hidden from the workspace list; owners and admins can unarchive it).";
    case "question.ask":
      return `Starts a ${String(p.source ?? "live")} investigation${p.question ? ` of ${q(p.question)}` : " of the workspace objective"} with the minimum budget (up to USD ${MIN_QUESTION_BUDGET.usd} of model spend).`;
    case "run.await":
      return "Follows the run, approves only the canvas patch that costs nothing, and pauses for you on any other approval.";
    case "setup.auto":
      return "Creates up to 3 markers, up to 3 monitor rules and one draft hypothesis from the run's findings. Nothing is frozen or published.";
    case "marker.create":
      return `Creates a marker on panel ${String(p.panelId)} at ${String(p.at)}.`;
    case "monitor.create":
      return `Creates a rule that fires when ${String(p.metricId)} ${String(p.op)} ${String(p.value)} on source ${String(p.sourceId)}.`;
    case "hypothesis.create":
      return `Creates a draft hypothesis: ${q(p.proposition)}. It is not frozen.`;
    case "hypothesis.freeze":
      return "Freezes the hypothesis so it can no longer be edited (you can only amend it afterwards).";
    case "capsule.build":
      return "Builds a capsule from the run's panel results (nothing is invented or padded).";
    case "capsule.prove":
      return "Runs the verifier on OutLayer (testnet); the deposit and gas are charged to your credits.";
    case "capsule.publish":
      return "Publishes the capsule to the public gateway with its verification badge; a testnet anchor may burn gas charged to your credits.";
    case "report.build":
      return "Checks the report data for the workspace and links the report page and the PDF.";
  }
}

/** Consent requirements derived from the steps. `proofEstimateYocto` is the server's current hold for one proof (null if unknown). */
export function consentFor(steps: PlannedStep[], proofEstimateYocto: string | null): ConsentRequirement[] {
  const out = new Map<ConsentKey, ConsentRequirement>();
  const proves = steps.filter((s) => s.key === "capsule.prove").length;
  const publishes = steps.filter((s) => s.key === "capsule.publish").length;
  const maxProof =
    proofEstimateYocto !== null && proves > 0
      ? (BigInt(proofEstimateYocto) * BigInt(proves)).toString()
      : null;
  for (const s of steps)
    for (const k of STEP_CONSENT[s.key] ?? []) {
      if (out.has(k)) continue;
      if (k === "spend_credits")
        out.set(k, {
          key: k,
          label: "Spend NEAR credits",
          detail:
            (proves > 0
              ? maxProof
                ? `Up to ${nearOf(maxProof)} NEAR of your credits is held for the OutLayer proof; only what it really costs (OutLayer charge plus gas) is charged and the rest is released.`
                : "The OutLayer proof cost cannot be estimated right now; it is held from your credits and only what it really costs is charged."
              : "") + (publishes > 0 ? " Publishing may anchor on testnet and charge the gas burnt." : ""),
          maxYocto: maxProof,
        });
      else if (k === "publish_public")
        out.set(k, {
          key: k,
          label: "Publish publicly",
          detail:
            "The capsule becomes publicly visible with its verification badge. If the publish route lists cautions (for example INSUFFICIENT_DATA) the task stops and asks you to acknowledge them.",
          maxYocto: null,
        });
      else if (k === "freeze_hypothesis")
        out.set(k, {
          key: k,
          label: "Freeze a hypothesis",
          detail: "A frozen hypothesis can no longer be edited, only amended.",
          maxYocto: null,
        });
      else
        out.set(k, {
          key: k,
          label: "Archive the workspace",
          detail: "The workspace is hidden from the workspace list until an owner or admin unarchives it.",
          maxYocto: null,
        });
    }
  return [...out.values()];
}

export function modelUsdMaxFor(steps: PlannedStep[]): string {
  const n = steps.filter((s) => s.key === "question.ask").length;
  return (n * MIN_QUESTION_BUDGET.usd).toFixed(6);
}
export const QUESTION_BUDGET = { ...MIN_QUESTION_BUDGET };

export const PLANNER_STEP_KEYS_NOTE = `Valid step keys: ${STEP_KEYS.join(", ")}.`;
