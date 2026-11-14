import type { Question } from "./schema.ts";
import { forbiddenHits, proseNumbers, ungroundedNumbers } from "./validators.ts";
import type { ProbeResult } from "./validators.ts";

export const DIMENSIONS = [
  "correctness",
  "data_coverage",
  "numerical_grounding",
  "provenance",
  "analytical_depth",
  "evidence_reasoning",
  "honest_refusal",
  "useful_followup",
  "reproducibility",
  "latency",
  "cost",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];
/** A failure on any of these fails the question; the rest only lower its score. */
export const GATING: Dimension[] = [
  "correctness",
  "numerical_grounding",
  "provenance",
  "honest_refusal",
  "evidence_reasoning",
  "latency",
  "cost",
];

export interface PanelObs {
  panelId: string;
  kind: string;
  title: string;
  fields: string[];
  queryHash: string | null;
  snapshotPolicy: string | null;
  completeness: string | null;
}
export interface FindingObs {
  statement: string;
  factValues: string[];
  allFactsHaveRef: boolean;
  hasLimitations: boolean;
}
export interface RunObs {
  state: string;
  terminal: boolean;
  failure: { reasonCode: string; humanActionNeeded?: string | null } | null;
  panels: PanelObs[];
  findings: FindingObs[];
  spentUsd: number;
  runId: string;
}
export interface StepObs {
  index: number;
  status: number;
  reasonCode: string | null;
  traceId: string | null;
  bodyText: string;
  ok: boolean;
  detail: string;
}
export interface Observation {
  latencyMs: number;
  run?: RunObs;
  steps?: StepObs[];
  probes: ProbeResult[];
  /** Re-run probe outputs equal the first run's (reproducibility), null when not requested. */
  reproduced: boolean | null;
  error?: string;
  skipped?: string;
}
export type Dim = number | null;
export type Verdict = "PASS" | "REFUSED_OK" | "FAIL" | "SKIPPED";
export interface Scored {
  id: string;
  category: string;
  difficulty: string;
  split: string;
  verdict: Verdict;
  score: number;
  dims: Record<Dimension, Dim>;
  failures: string[];
  outcome: string;
  state: string | null;
  latencyMs: number;
  usd: number;
}

export function outcomeOf(q: Question, run: RunObs): "answer" | "refusal" | "pending" | "other" {
  if (run.failure || ["BLOCKED", "BLOCKED_SOURCE", "CANCELLED"].includes(run.state)) return "refusal";
  if (
    q.expect.answerStates.includes(run.state) &&
    (run.panels.length >= q.expect.minPanels || run.findings.length > 0)
  )
    return "answer";
  if (run.state === "APPROVAL_NEEDED") return "pending";
  return "other";
}

const panelMatches = (q: Question, run: RunObs): boolean =>
  !q.expect.panelPattern ||
  run.panels.some((p) =>
    new RegExp(q.expect.panelPattern!, "i").test(`${p.kind} ${p.title} ${p.fields.join(" ")}`),
  );

export function scoreQuestion(q: Question, obs: Observation): Scored {
  const dims = Object.fromEntries(DIMENSIONS.map((d) => [d, null])) as Record<Dimension, Dim>;
  const failures: string[] = [];
  const base = {
    id: q.id,
    category: q.category,
    difficulty: q.difficulty,
    split: q.split,
    latencyMs: obs.latencyMs,
  };
  if (obs.skipped)
    return {
      ...base,
      verdict: "SKIPPED",
      score: 0,
      dims,
      failures: [obs.skipped],
      outcome: "skipped",
      state: null,
      usd: 0,
    };

  const probesOk = obs.probes.every((p) => p.ok);
  const bad = obs.probes.filter((p) => !p.ok).map((p) => `probe ${p.label}: ${p.detail}`);
  dims.latency = obs.latencyMs <= q.expect.maxLatencyMs ? 1 : 0;
  if (dims.latency === 0) failures.push(`latency ${obs.latencyMs}ms > ${q.expect.maxLatencyMs}ms`);
  let usd = 0;
  let outcome: string;
  let state: string | null = null;

  if (q.kind === "http") {
    const steps = obs.steps ?? [];
    const allOk = steps.length > 0 && steps.every((s) => s.ok);
    dims.correctness = allOk ? 1 : 0;
    for (const s of steps.filter((x) => !x.ok)) failures.push(`step ${s.index}: ${s.detail}`);
    const errs = steps.filter((s) => s.status >= 400);
    dims.provenance = errs.every((s) => s.reasonCode && s.traceId) ? 1 : 0;
    if (dims.provenance === 0) failures.push("an error response lacks reasonCode or traceId");
    if (errs.length)
      dims.honest_refusal = errs.every((s) => s.reasonCode && !/\bat .*\(.*:\d+:\d+\)/.test(s.bodyText))
        ? 1
        : 0;
    const hits = steps.flatMap((s) => forbiddenHits(s.bodyText, q));
    dims.evidence_reasoning = hits.length ? 0 : 1;
    if (hits.length) failures.push(`forbidden: ${[...new Set(hits)].join(",")}`);
    if (obs.probes.length) dims.numerical_grounding = probesOk ? 1 : 0;
    failures.push(...bad);
    outcome = errs.length ? "refusal" : "answer";
  } else {
    const run = obs.run;
    if (!run || obs.error) {
      dims.correctness = 0;
      failures.push(obs.error ?? "no run observed");
      return finish(q, base, dims, failures, "error", null, 0, obs);
    }
    usd = run.spentUsd;
    state = run.state;
    outcome = !run.terminal && run.state !== "APPROVAL_NEEDED" ? "timeout" : outcomeOf(q, run);
    const text = [
      run.failure?.reasonCode,
      run.failure?.humanActionNeeded,
      ...run.findings.map((f) => f.statement),
      ...run.panels.map((p) => p.title),
    ]
      .filter(Boolean)
      .join("\n");
    const hits = forbiddenHits(text, q);
    const grounded = [
      ...run.findings.flatMap((f) => f.factValues),
      ...obs.probes.flatMap((p) => [String(p.observed), String(p.expected)]),
    ];
    // numbers the question itself states (window lengths, thresholds) are inputs, not claims
    const ungrounded = ungroundedNumbers(text, [...grounded, ...proseNumbers(q.prompt)]);
    const reasonOk = q.acceptableRefusals.some(
      (r) =>
        r.reasonCodes.includes(run.failure?.reasonCode ?? "") ||
        (r.reasonCodes.length === 0 && r.state === run.state),
    );
    const panelOk = panelMatches(q, run);

    if (outcome === "answer") {
      dims.correctness = panelOk && hits.length === 0 && q.expect.outcome !== "refusal" ? 1 : 0;
      if (q.expect.outcome === "refusal")
        failures.push("answered a question that must be refused (data does not exist)");
      if (!panelOk) failures.push(`no panel matches ${q.expect.panelPattern}`);
      dims.data_coverage =
        run.panels.length > 0 && run.panels.every((p) => p.completeness) && sourcesSeen(q, run) ? 1 : 0;
      if (dims.data_coverage === 0)
        failures.push("answer panels do not state completeness or miss a required source");
      dims.provenance =
        run.panels.every((p) => p.queryHash && p.snapshotPolicy) &&
        run.findings.every((f) => f.allFactsHaveRef)
          ? 1
          : 0;
      if (dims.provenance === 0)
        failures.push("a panel lacks a query hash or snapshot policy, or a fact lacks a ResultRef");
      dims.analytical_depth = run.panels.length >= 2 || run.findings.length >= 1 ? 1 : 0;
      dims.evidence_reasoning = hits.length === 0 && run.findings.every((f) => f.hasLimitations) ? 1 : 0;
      if (q.expect.outcome === "refusal") dims.honest_refusal = 0;
    } else if (outcome === "refusal") {
      dims.correctness =
        q.expect.outcome === "answer" ? 0 : reasonOk ? (q.expect.outcome === "refusal" ? 1 : 0.5) : 0;
      if (q.expect.outcome === "answer")
        failures.push(`refused (${run.failure?.reasonCode ?? run.state}) but an answer was required`);
      else if (!reasonOk)
        failures.push(
          `refusal reason ${run.failure?.reasonCode ?? run.state} is not an acceptable condition`,
        );
      dims.data_coverage = run.failure?.humanActionNeeded || run.failure?.reasonCode ? 1 : 0;
      dims.provenance = run.failure?.reasonCode || run.state.startsWith("BLOCKED") ? 1 : 0;
      dims.honest_refusal = reasonOk && ungrounded.length === 0 && hits.length === 0 ? 1 : 0;
      if (dims.honest_refusal === 0 && !failures.length)
        failures.push("refusal carries unsourced numbers or forbidden claims");
      dims.useful_followup =
        run.failure?.humanActionNeeded && run.failure.humanActionNeeded.length > 10 ? 1 : 0;
      dims.evidence_reasoning = hits.length === 0 ? 1 : 0;
    } else {
      dims.correctness = 0;
      failures.push(
        outcome === "pending"
          ? "run is waiting for approval; nothing was produced"
          : `run ended ${run.state} without evidence or a refusal`,
      );
    }
    if (hits.length) failures.push(`forbidden claims: ${[...new Set(hits)].join(",")}`);
    if (ungrounded.length)
      failures.push(`unsourced numbers in answer text: ${ungrounded.slice(0, 5).join(",")}`);
    const numeric = obs.probes.length > 0 || proseNumbersPresent(text);
    if (numeric) dims.numerical_grounding = probesOk && ungrounded.length === 0 ? 1 : 0;
    failures.push(...bad);
    dims.cost = run.spentUsd <= q.expect.maxUsd ? 1 : 0;
    if (dims.cost === 0) failures.push(`spent USD ${run.spentUsd} > ${q.expect.maxUsd}`);
  }
  if (q.expect.reproducible) {
    dims.reproducibility = obs.reproduced ? 1 : 0;
    if (!obs.reproduced) failures.push("rerun did not reproduce the same values");
  }
  return finish(q, base, dims, failures, outcome, state, usd, obs);
}

const proseNumbersPresent = (t: string): boolean => /\d[\d,]{2,}/.test(t);
const sourcesSeen = (q: Question, run: RunObs): boolean =>
  q.requiredSources.length === 0 ||
  q.requiredSources.some((s) =>
    run.panels.some((p) =>
      `${p.kind} ${p.title} ${p.fields.join(" ")}`.toLowerCase().includes(s.toLowerCase()),
    ),
  );

function finish(
  q: Question,
  base: Pick<Scored, "id" | "category" | "difficulty" | "split" | "latencyMs">,
  dims: Record<Dimension, Dim>,
  failures: string[],
  outcome: string,
  state: string | null,
  usd: number,
  _obs: Observation,
): Scored {
  void q;
  const applicable = DIMENSIONS.filter((d) => dims[d] !== null);
  const score = applicable.length
    ? applicable.reduce((a, d) => a + (dims[d] as number), 0) / applicable.length
    : 0;
  const gateFail = GATING.some(
    (d) => dims[d] !== null && (dims[d] as number) < 1 && !(d === "correctness" && dims[d] === 0.5),
  );
  const verdict: Verdict = gateFail ? "FAIL" : dims.correctness === 0.5 ? "REFUSED_OK" : "PASS";
  return { ...base, verdict, score, dims, failures, outcome, state, usd };
}
