import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { InferenceProvider } from "@nearesis/contracts";
import {
  KernelError,
  guardInference,
  isGuardedInference,
  modelPolicyFromEnv,
  workspaceNotFound,
  zodDetails,
} from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import {
  ClickHouseAccountSource,
  ClickHouseEntitySource,
  IntentsAnalytics,
  createCh,
  type AnalyticsDeps,
} from "@nearesis/analytics";
import {
  answerQuestion,
  assistantModelOver,
  assistantProviderFromEnv,
  externalModelSpend,
  readGlobalSpend,
  type AssistantSpendGate,
} from "@nearesis/workflow";
import { assistantSetup } from "./assistant-setup.ts";
import { ctxOf } from "./product-common.ts";
import { chargeModelUsd, requireCredits } from "./usd-credits-api.ts";
import type { RunsService } from "./runs.ts";

export interface AssistantRoutesOptions {
  kernel: Kernel;
  runs: RunsService;
  authenticate(req: FastifyRequest): Promise<Session>;
  /** Test seam: the analytics sources. Default: the live ClickHouse database (nearesis_live), created lazily. */
  analytics?: AnalyticsDeps;
  /** Test seam: the model. Default: the configured model through the guarded inference provider (never the mock). */
  inference?: { provider: InferenceProvider; model: string };
  /** Model USD recorded outside Postgres (inference spend files). Default: the real spend files. */
  externalModelSpend?: () => Promise<number>;
  /** Answers per user per window (default 12 per minute). */
  answersPerWindow?: number;
  windowMs?: number;
}

export const AnswerRequest = z.strictObject({
  question: z.string().trim().min(1).max(2000),
  history: z
    .array(z.strictObject({ role: z.enum(["user", "assistant"]), text: z.string().max(2000) }))
    .max(6)
    .optional(),
});
export const SetupRequest = z.strictObject({ runId: z.uuid() });
const Uuid = z.uuid();

const Cell = z.string().nullable();
export const AnswerResponse = z.strictObject({
  answerId: z.uuid(),
  status: z.enum(["ok", "partial", "cannot_answer"]),
  summary: z.string().nullable(),
  charts: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      kind: z.enum(["line", "bar", "table"]),
      unit: z.string().nullable(),
      x: z.array(z.string()),
      series: z.array(z.strictObject({ name: z.string(), values: z.array(Cell) })),
      columns: z.array(z.string()).optional(),
      rows: z.array(z.array(Cell)).optional(),
      source: z.string(),
      window: z.strictObject({ from: z.string(), to: z.string() }).nullable(),
      coverage: z.string().nullable(),
      metricVersion: z.string().nullable(),
      caveats: z.array(z.string()),
    }),
  ),
  findings: z.array(
    z.strictObject({
      statement: z.string(),
      basis: z.enum(["observation", "inference"]),
      status: z.enum(["supported", "mixed", "insufficient_data", "cannot_compute"]),
      chartIds: z.array(z.string()),
      facts: z.array(z.strictObject({ value: z.string(), unit: z.string().nullable() })),
      limitations: z.array(z.string()),
      skepticNotes: z.array(z.string()),
      skepticVerdict: z.enum(["holds", "weakened", "unsupported", "unavailable"]),
    }),
  ),
  limitations: z.array(z.string()),
  steps: z.array(
    z.strictObject({
      tool: z.string(),
      label: z.string(),
      outcome: z.enum(["ok", "cannot_compute", "refused", "error"]),
      ms: z.number(),
    }),
  ),
  cannotAnswerReason: z.string().nullable(),
  suggestedWorkspaceObjective: z.string(),
  cost: z.strictObject({ usd: z.number(), modelCalls: z.number().int() }),
  elapsedMs: z.number(),
});
const Made = z.strictObject({ id: z.string(), title: z.string(), reason: z.string() });
export const SetupResponse = z.strictObject({
  markers: z.array(Made),
  monitors: z.array(Made),
  hypothesis: z.strictObject({ id: z.string(), title: z.string() }).nullable(),
  skipped: z.array(z.strictObject({ kind: z.enum(["marker", "monitor", "hypothesis"]), reason: z.string() })),
  cost: z.strictObject({ usd: z.number(), modelCalls: z.number().int() }),
});

/**
 * Agent tab endpoints.
 *
 *   POST /v1/assistant/answer                      quick answer: typed read-only analytics, charts, grounded findings
 *   POST /v1/workspaces/:id/assistant/setup        markers, monitor rules and one DRAFT hypothesis from a completed run
 *
 * The answer spends model USD (planner, analyst, skeptic) against the one global ceiling and is refused with 402
 * BUDGET_EXCEEDED when it is reached. The setup is deterministic and spends nothing; it is idempotent per run.
 */
export const assistantRoutes: FastifyPluginAsync<AssistantRoutesOptions> = async (app, opts) => {
  const { kernel, authenticate } = opts;
  let ch: ReturnType<typeof createCh> | null = null;
  const analytics = (): AnalyticsDeps => {
    if (opts.analytics) return opts.analytics;
    const database = process.env.NEARESIS_CH_LIVE_DATABASE ?? "nearesis_live";
    ch ??= createCh({ database });
    return {
      intents: new IntentsAnalytics(ch, { database }),
      entities: new ClickHouseEntitySource(ch),
      accounts: new ClickHouseAccountSource(ch),
    };
  };
  app.addHook("onClose", async () => {
    await ch?.close();
  });

  const windowMs = opts.windowMs ?? 60_000;
  const perWindow = opts.answersPerWindow ?? 12;
  const buckets = new Map<string, { start: number; n: number }>();
  const take = (userId: string): number | null => {
    const t = Date.now();
    let b = buckets.get(userId);
    if (!b || t - b.start >= windowMs) {
      b = { start: t, n: 0 };
      buckets.set(userId, b);
    }
    b.n++;
    if (buckets.size > 5000) for (const [k, v] of buckets) if (t - v.start >= windowMs) buckets.delete(k);
    return b.n <= perWindow ? null : Math.max(1, Math.ceil((b.start + windowMs - t) / 1000));
  };

  const external = opts.externalModelSpend ?? externalModelSpend();
  /** The ceiling and committed figure the cost routes report: ledger mirror plus the inference spend files. */
  const gateFor = async (s: Session): Promise<AssistantSpendGate> => {
    const read = () =>
      kernel.db.tx(ctxOf(s), async (tx) => {
        await tx.query("SELECT set_config('search_path', 'runtime, public', true)");
        const g = await readGlobalSpend(tx, new Date(), external);
        return { committed: g.committedUsd, ceiling: g.ceilingUsd };
      });
    const first = await read();
    return {
      ceilingUsd: first.ceiling,
      committedUsd: async () => (await read()).committed,
    };
  };

  app.post("/v1/assistant/answer", async (req) => {
    const s = await authenticate(req);
    const body = AnswerRequest.safeParse(req.body);
    if (!body.success)
      throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request body.", {
        details: zodDetails(body.error),
      });
    const wait = take(s.userId);
    if (wait !== null)
      throw new KernelError("RATE_LIMITED", "TOO_MANY_ANSWERS", "Too many questions in a short time.", {
        retryable: true,
        nextAction: `Retry after ${wait} seconds.`,
      });
    // Credits: nothing starts when the caller's USD credits are used up (402 CREDITS_EXHAUSTED).
    await requireCredits(kernel, s);
    const chosen = opts.inference ?? assistantProviderFromEnv();
    // FND-073: the egress policy applies to whichever provider is used, injected or configured.
    const provider = isGuardedInference(chosen.provider)
      ? chosen.provider
      : guardInference(chosen.provider, modelPolicyFromEnv());
    const model = chosen.model;
    if (provider.id === "mock" && !opts.inference)
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "MODEL_NOT_CONFIGURED",
        "No live model is configured for quick answers.",
        { retryable: false },
      );
    const abort = new AbortController();
    req.raw.once("close", () => {
      if (!req.raw.complete) abort.abort();
    });
    const modelPort = assistantModelOver(provider, model, await gateFor(s), abort.signal);
    const charge = (usd: number, refId: string, modelCalls: number) =>
      chargeModelUsd(kernel.db, ctxOf(s), usd, { refKind: "answer", refId, detail: { modelCalls } }).catch(
        (err) => app.log.error({ err: (err as Error).message }, "charging the answer's model spend failed"),
      );
    try {
      const answer = await answerQuestion(
        { analytics: analytics(), model: modelPort, tenantId: s.principal.orgId },
        { question: body.data.question, ...(body.data.history ? { history: body.data.history } : {}) },
      );
      // The ACTUAL provider-priced USD of this turn (the same figure the answer reports), charged once per answer.
      await charge(answer.cost.usd, answer.answerId, answer.cost.modelCalls);
      return answer;
    } catch (e) {
      // A turn that failed part-way still spent what its calls cost.
      const spent = modelPort.usage();
      await charge(spent.usd, randomUUID(), spent.modelCalls);
      if (e instanceof KernelError) throw e;
      const code = (e as { code?: unknown } | null)?.code;
      if (code === "BUDGET_EXCEEDED")
        throw new KernelError("BUDGET_EXCEEDED", "GLOBAL_CEILING", "The model-spend ceiling is reached.");
      if (e instanceof ZodError)
        throw new KernelError(
          "UPSTREAM_DEGRADED",
          "MODEL_OUTPUT_INVALID",
          "The model returned an unusable plan.",
          {
            retryable: true,
          },
        );
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "MODEL_UNAVAILABLE",
        "The model could not answer just now.",
        {
          retryable: true,
        },
      );
    }
  });

  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/assistant/setup", async (req) => {
    const s = await authenticate(req);
    if (!Uuid.safeParse(req.params.id).success) throw workspaceNotFound();
    const body = SetupRequest.safeParse(req.body);
    if (!body.success)
      throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request body.", {
        details: zodDetails(body.error),
      });
    // Idempotency-Key is accepted for convention; the setup is idempotent per run by construction (deterministic ids).
    const hdr = req.headers["idempotency-key"];
    if (hdr !== undefined && (typeof hdr !== "string" || hdr.length < 1 || hdr.length > 200))
      throw new KernelError(
        "VALIDATION_FAILED",
        "INVALID_IDEMPOTENCY_KEY",
        "Invalid Idempotency-Key header.",
      );
    await requireCredits(kernel, s);
    const made = await assistantSetup(
      { kernel, runs: opts.runs, analytics },
      s,
      req.params.id,
      body.data.runId,
      req.traceId,
    );
    // Deterministic today (cost 0); whatever model spend it reports is charged to the caller, once per run.
    await chargeModelUsd(kernel.db, ctxOf(s), made.cost.usd, {
      refKind: "setup",
      refId: body.data.runId,
      detail: { workspaceId: req.params.id, modelCalls: made.cost.modelCalls },
    }).catch((err) =>
      app.log.error({ err: (err as Error).message }, "charging the setup's model spend failed"),
    );
    return made;
  });
};
