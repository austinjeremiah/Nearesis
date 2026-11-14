import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Golden trace of the 12-step investment-question lifecycle (ch.25 "Exact lifecycle", ch.16b B05).
 * The recorder runs each step through the component that owns it, hashes its input and output, links the evidence it
 * produced, and refuses to run a step whose upstream dependency did not complete (the step is recorded `blocked`).
 */
export const STEP_NAMES = [
  "create",
  "preregister",
  "acquire",
  "discover",
  "plan",
  "execute",
  "compose",
  "investigate",
  "monitor",
  "audit",
  "publish",
  "commit",
] as const;
export type StepName = (typeof STEP_NAMES)[number];

export const StepMode = z.enum(["fixture", "recorded", "live", "mock"]);
export type StepMode = z.infer<typeof StepMode>;

/** Which earlier steps' output a step consumes (the last entry is the primary input whose output hash is the upstream link). A failed or blocked dependency blocks the step. */
export const DEPENDS_ON: Record<StepName, StepName[]> = {
  create: [],
  preregister: ["create"],
  acquire: ["create"],
  discover: ["acquire"],
  plan: ["preregister", "discover"],
  execute: ["plan"],
  compose: ["execute"],
  investigate: ["compose"],
  monitor: ["acquire", "compose"],
  audit: ["execute", "investigate"],
  publish: ["compose", "audit"],
  commit: ["publish"],
};

/**
 * Component id prefixes whose output may legitimately be produced by a documented dev-only provider. Every other
 * component (data, semantic, research, canvas, kernel, publisher) must never be `mock`.
 */
export const MOCK_ALLOWED_PREFIXES = ["inference.", "attestation."] as const;

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
export const TraceStep = z.strictObject({
  n: z.number().int().min(1).max(12),
  name: z.enum(STEP_NAMES),
  component: z.strictObject({ id: z.string().min(1), version: z.string().min(1) }),
  mode: StepMode,
  status: z.enum(["completed", "blocked", "failed"]),
  /** hash of the exact input object (includes `upstream`) */
  inputHash: Hash,
  /** output hash of the step this one consumed (null for roots, or when the upstream never completed) */
  upstream: Hash.nullable(),
  outputHash: Hash.nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  evidence: z.array(z.strictObject({ kind: z.string().min(1), ref: z.string().min(1) })),
  reason_code: z.string().nullable(),
  blockedBy: z.array(z.enum(STEP_NAMES)),
  detail: z.string().nullable(),
});
export type TraceStep = z.infer<typeof TraceStep>;

export const GoldenTrace = z.strictObject({
  schemaVersion: z.literal("nearesis.golden-trace.v1"),
  traceId: z.string().min(1),
  workspaceId: z.string().min(1),
  question: z.string().min(1),
  mode: StepMode,
  steps: z.array(TraceStep),
});
export type GoldenTrace = z.infer<typeof GoldenTrace>;

export const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
export const sha256 = (v: unknown): string => createHash("sha256").update(canon(v)).digest("hex");

export interface StepSpec {
  component: { id: string; version: string };
  mode: StepMode;
  input?: unknown;
}
export interface StepOutcome {
  output: unknown;
  evidence?: Array<{ kind: string; ref: string }>;
}
export class StepFailure extends Error {
  constructor(
    readonly reason_code: string,
    message: string,
  ) {
    super(message);
  }
}

export class TraceRecorder {
  readonly steps: TraceStep[] = [];
  private readonly outputs = new Map<StepName, string | null>();
  private readonly statuses = new Map<StepName, TraceStep["status"]>();
  constructor(
    private readonly o: {
      traceId: string;
      workspaceId: string;
      question: string;
      mode: StepMode;
      clock?: () => string;
    },
  ) {}
  private now = () => (this.o.clock ?? (() => new Date().toISOString()))();

  /** Runs one lifecycle step. Returns its output, or undefined when it failed or was blocked (never throws for a step failure). */
  async step<T>(
    name: StepName,
    spec: StepSpec,
    fn: () => Promise<StepOutcome & { output: T }>,
  ): Promise<T | undefined> {
    const idx = STEP_NAMES.indexOf(name);
    const deps = DEPENDS_ON[name];
    const bad = deps.filter((d) => this.statuses.get(d) !== "completed");
    const upstreamName = [...deps].reverse().find((d) => this.statuses.get(d) === "completed");
    const upstream = upstreamName ? (this.outputs.get(upstreamName) ?? null) : null;
    const startedAt = this.now();
    const base = {
      n: idx + 1,
      name,
      component: spec.component,
      mode: spec.mode,
      inputHash: sha256({ name, input: spec.input ?? null, upstream }),
      upstream,
      startedAt,
    };
    if (bad.length) {
      this.push({
        ...base,
        status: "blocked",
        outputHash: null,
        endedAt: this.now(),
        evidence: [],
        reason_code: "UPSTREAM_NOT_COMPLETED",
        blockedBy: bad,
        detail: `blocked by ${bad.join(", ")}`,
      });
      return undefined;
    }
    try {
      const r = await fn();
      const outputHash = sha256(r.output);
      this.push({
        ...base,
        status: "completed",
        outputHash,
        endedAt: this.now(),
        evidence: r.evidence ?? [],
        reason_code: null,
        blockedBy: [],
        detail: null,
      });
      return r.output;
    } catch (e) {
      const rc =
        e instanceof StepFailure
          ? e.reason_code
          : ((e as { reasonCode?: string }).reasonCode ?? "STEP_FAILED");
      this.push({
        ...base,
        status: "failed",
        outputHash: null,
        endedAt: this.now(),
        evidence: [],
        reason_code: rc,
        blockedBy: [],
        detail: String((e as Error).message ?? e).slice(0, 500),
      });
      return undefined;
    }
  }
  /** Records a step that cannot run for a documented external reason (e.g. a testnet commit awaiting the owner). */
  async blocked(
    name: StepName,
    spec: StepSpec,
    reason_code: string,
    detail: string,
    evidence: Array<{ kind: string; ref: string }> = [],
  ): Promise<void> {
    await this.step(name, spec, async () => {
      throw new StepFailure(reason_code, detail);
    });
    const s = this.steps[this.steps.length - 1]!;
    if (s.name === name && s.status === "failed") {
      s.status = "blocked";
      s.evidence = evidence;
      this.statuses.set(name, "blocked");
    }
  }
  private push(s: TraceStep): void {
    this.steps.push(s);
    this.outputs.set(s.name, s.outputHash);
    this.statuses.set(s.name, s.status);
  }
  trace(): GoldenTrace {
    return {
      schemaVersion: "nearesis.golden-trace.v1",
      traceId: this.o.traceId,
      workspaceId: this.o.workspaceId,
      question: this.o.question,
      mode: this.o.mode,
      steps: this.steps.map((s) => ({ ...s })),
    };
  }
}

export interface TraceViolation {
  rule:
    | "schema"
    | "missing_step"
    | "order"
    | "continuity"
    | "mock_not_allowed"
    | "swallowed_failure"
    | "completed_with_bad_dependency"
    | "no_component_version"
    | "evidence_missing";
  step?: StepName;
  detail: string;
}

/**
 * Validates a golden trace independent of the recorder that produced it. `expectComplete` is true for the success run:
 * all 12 steps present in order. A run with a planted failure may end with blocked steps but must report them.
 */
export function validateTrace(raw: unknown): {
  ok: boolean;
  violations: TraceViolation[];
  trace?: GoldenTrace;
} {
  const parsed = GoldenTrace.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      violations: [{ rule: "schema", detail: parsed.error.issues.map((i) => i.message).join("; ") }],
    };
  const t = parsed.data;
  const v: TraceViolation[] = [];
  STEP_NAMES.forEach((name, i) => {
    const s = t.steps[i];
    if (!s || s.name !== name)
      v.push({
        rule: s && t.steps.some((x) => x.name === name) ? "order" : "missing_step",
        step: name,
        detail: `expected step ${i + 1} ${name}, found ${s?.name ?? "none"}`,
      });
  });
  if (t.steps.length !== 12)
    v.push({ rule: "missing_step", detail: `trace has ${t.steps.length} steps, expected 12` });
  const by = new Map(t.steps.map((s) => [s.name, s]));
  for (const s of t.steps) {
    if (s.mode === "mock" && !MOCK_ALLOWED_PREFIXES.some((p) => s.component.id.startsWith(p)))
      v.push({
        rule: "mock_not_allowed",
        step: s.name,
        detail: `component ${s.component.id} ran as mock; only ${MOCK_ALLOWED_PREFIXES.join(", ")} may`,
      });
    if (s.status === "failed" && !s.reason_code)
      v.push({ rule: "swallowed_failure", step: s.name, detail: "failed step without reason_code" });
    if (s.status === "completed" && !s.evidence.length)
      v.push({ rule: "evidence_missing", step: s.name, detail: "completed step links no evidence" });
    for (const d of DEPENDS_ON[s.name]) {
      const dep = by.get(d);
      if (s.status === "completed" && dep && dep.status !== "completed")
        v.push({
          rule: "completed_with_bad_dependency",
          step: s.name,
          detail: `${s.name} completed although ${d} is ${dep.status}`,
        });
    }
    const deps = DEPENDS_ON[s.name].map((d) => by.get(d)).filter((x) => x && x.status === "completed");
    if (s.status === "completed" && deps.length) {
      // continuity: the step consumed the output of its latest completed dependency
      const want = deps[deps.length - 1]!.outputHash;
      if (s.upstream !== want)
        v.push({
          rule: "continuity",
          step: s.name,
          detail: `upstream ${String(s.upstream).slice(0, 12)} != ${deps[deps.length - 1]!.name} output ${String(want).slice(0, 12)}`,
        });
    }
  }
  return { ok: v.length === 0, violations: v, trace: t };
}
