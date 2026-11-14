import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z, ZodError } from "zod";
import type { InferenceProvider } from "@nearesis/contracts";
import {
  KernelError,
  canWrite,
  guardInference,
  isGuardedInference,
  modelPolicyFromEnv,
  usdNumberToMicro,
} from "@nearesis/kernel";
import type { Session } from "@nearesis/kernel";
import { APP_ROOT } from "@nearesis/capsule";
import {
  assistantModelOver,
  assistantProviderFromEnv,
  externalModelSpend,
  readGlobalSpend,
} from "@nearesis/workflow";
import type { AssistantSpendGate } from "@nearesis/workflow";
import { Uuid, audit, ctxOf, parseBody } from "./product-common.ts";
import type { ProductDeps } from "./product-common.ts";
import { chargeModelUsd, requireCredits } from "./usd-credits-api.ts";
import {
  CHALLENGE_SYSTEM,
  ChallengeDraft,
  answerProblem,
  factsOf,
  outcomeOf,
  promptOf,
  readChallenges,
  validateNotes,
  viewOfRow,
} from "./user-thesis/challenges.ts";
import type { ChallengeRow, ChallengeView, Note } from "./user-thesis/challenges.ts";

/**
 * Thesis challenges.
 *
 *   POST /v1/theses/:id/challenge                  one skeptic model call over the thesis (signed in, credits gate, charged to the caller)
 *   GET  /v1/theses/:id/challenges                 the challenges of a thesis visible to the caller (newest first)
 *   POST /v1/theses/:id/challenges/:cid/answer     the owning organisation's answer (editor or above), once per challenge
 *
 * A challenge never changes the thesis document or its hash; it is stored beside the thesis. The model's notes are untrusted:
 * each one is kept only when every number in it matches a listed fact, the wording rules pass and it carries no advice. The
 * outcome is computed from the kept notes by the fixed rule documented in `user-thesis/challenges.ts`.
 */

export const REFERENCE_ID = "reference-near-intents";

export interface ThesisChallengeRoutesOptions extends ProductDeps {
  /** Test seam: the model. Default: the configured model through the guarded inference provider (never the mock). */
  inference?: { provider: InferenceProvider; model: string };
  /** Model USD recorded outside Postgres (inference spend files). Default: the real spend files. */
  externalModelSpend?: () => Promise<number>;
  /** Challenges per user per window (default 30 per minute). */
  perWindow?: number;
  windowMs?: number;
}

const AnswerBody = z.strictObject({ text: z.string().trim().min(1).max(600) });

const thesisDir = (): string => process.env.NEARESIS_THESIS_DIR ?? join(APP_ROOT, "thesis");
const notFound = (): KernelError => new KernelError("NOT_FOUND", "THESIS_NOT_FOUND", "Thesis not found.");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

function referenceDoc(): Doc {
  const p = join(thesisDir(), "build", "thesis.json");
  if (!existsSync(p))
    throw new KernelError(
      "UPSTREAM_DEGRADED",
      "THESIS_NOT_BUILT",
      "The thesis bundle has not been built; run pnpm thesis:build.",
    );
  return { ...(JSON.parse(readFileSync(p, "utf8")) as Doc), origin: { kind: "reference" } };
}

/**
 * For the agent step `thesis.challenge`: the step calls `POST /v1/theses/<thesisId>/challenge` (no body) as the signed-in user
 * through the public API, then maps the response's `notes` to its result items with `challengeItems`.
 */
export const challengePath = (thesisId: string): string =>
  `/v1/theses/${encodeURIComponent(thesisId)}/challenge`;
export const challengeItems = (
  c: Pick<ChallengeView, "notes">,
): Array<{ text: string; group: string; severity: string }> =>
  c.notes.map((n) => ({ text: n.text, group: n.group, severity: n.severity }));

export const userThesisChallengeRoutes: FastifyPluginAsync<ThesisChallengeRoutesOptions> = async (
  app,
  opts,
) => {
  const { kernel, authenticate } = opts;
  const windowMs = opts.windowMs ?? 60_000;
  const perWindow = opts.perWindow ?? 30;
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
  /** The global ceiling and what is committed now (ledger mirror plus the inference spend files), exactly as the quick answer reads them. */
  const gateFor = async (s: Session): Promise<AssistantSpendGate> => {
    const read = () =>
      kernel.db.tx(ctxOf(s), async (tx) => {
        await tx.query("SELECT set_config('search_path', 'runtime, public', true)");
        const g = await readGlobalSpend(tx, new Date(), external);
        return { committed: g.committedUsd, ceiling: g.ceilingUsd };
      });
    const first = await read();
    return { ceilingUsd: first.ceiling, committedUsd: async () => (await read()).committed };
  };

  /** The thesis document as the caller may see it (row-level security), or the reference. 404 when not visible. */
  const visibleDoc = async (
    s: Session,
    id: string,
  ): Promise<{ doc: Doc; orgId: string | null; workspaceId: string | null }> => {
    if (id === REFERENCE_ID) return { doc: referenceDoc(), orgId: null, workspaceId: null };
    if (!Uuid.safeParse(id).success) throw notFound();
    const r = await kernel.db.tx(ctxOf(s), (tx) =>
      tx.query<{ doc: Doc; org_id: string; workspace_id: string }>(
        "SELECT doc, org_id, workspace_id FROM theses WHERE id = $1",
        [id],
      ),
    );
    const row = r.rows[0];
    if (!row) throw notFound();
    return { doc: row.doc, orgId: row.org_id, workspaceId: row.workspace_id };
  };
  const displayOf = async (s: Session): Promise<string | null> =>
    kernel.db.tx(
      ctxOf(s),
      async (tx) =>
        (
          await tx.query<{ display_name: string | null }>("SELECT display_name FROM users WHERE id = $1", [
            s.userId,
          ])
        ).rows[0]?.display_name ?? null,
    );

  app.post<{ Params: { id: string } }>("/v1/theses/:id/challenge", async (req) => {
    const s = await authenticate(req);
    const id = req.params.id;
    const { doc, orgId, workspaceId } = await visibleDoc(s, id);
    const wait = take(s.userId);
    if (wait !== null)
      throw new KernelError("RATE_LIMITED", "TOO_MANY_CHALLENGES", "Too many challenges in a short time.", {
        retryable: true,
        nextAction: `Retry after ${wait} seconds.`,
      });
    // Credits: nothing starts when the caller's USD credits are used up (402 CREDITS_EXHAUSTED).
    await requireCredits(kernel, s);
    const chosen = opts.inference ?? assistantProviderFromEnv();
    const provider = isGuardedInference(chosen.provider)
      ? chosen.provider
      : guardInference(chosen.provider, modelPolicyFromEnv());
    if (provider.id === "mock" && !opts.inference)
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "MODEL_NOT_CONFIGURED",
        "No live model is configured for challenges.",
        { retryable: false },
      );
    const abort = new AbortController();
    req.raw.once("close", () => {
      if (!req.raw.complete) abort.abort();
    });
    const model = assistantModelOver(provider, chosen.model, await gateFor(s), abort.signal);
    const challengeId = randomUUID();
    const facts = factsOf(doc);

    let kept: Note[] = [];
    let dropped = 0;
    let failed = false;
    try {
      const draft = await model.generate({
        key: `thesis-challenge:${challengeId}`,
        system: CHALLENGE_SYSTEM,
        prompt: promptOf(doc, facts),
        schema: ChallengeDraft,
        maxTokens: 1500,
      });
      ({ kept, dropped } = validateNotes(draft.notes, facts));
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      const isBudget =
        (e instanceof KernelError && e.code === "BUDGET_EXCEEDED") || code === "BUDGET_EXCEEDED";
      if (isBudget) {
        // the global ceiling: refused before any call; whatever was spent is still charged
        await charge(s, model.usage().usd, challengeId, model.usage().modelCalls);
        if (e instanceof KernelError) throw e;
        throw new KernelError("BUDGET_EXCEEDED", "GLOBAL_CEILING", "The model-spend ceiling is reached.");
      }
      if (e instanceof KernelError && e.code !== "UPSTREAM_DEGRADED") {
        await charge(s, model.usage().usd, challengeId, model.usage().modelCalls);
        throw e;
      }
      failed = true;
      app.log.warn(
        { err: e instanceof ZodError ? "MODEL_OUTPUT_INVALID" : (e as Error).message },
        "thesis challenge model call failed",
      );
    }
    const usage = model.usage();
    const outcome = outcomeOf(kept, dropped, failed);
    const micro = usdNumberToMicro(usage.usd);
    const by = await displayOf(s);
    const row = await kernel.db.tx(ctxOf(s), async (tx) => {
      const ins = await tx.query<ChallengeRow>(
        `INSERT INTO thesis_challenges(id, thesis_id, user_id, display_name, outcome, notes, dropped_notes, cost_usd_micro, model_calls)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, outcome, notes, dropped_notes, cost_usd_micro, model_calls, answer, answered_at, created_at, display_name`,
        [
          challengeId,
          id,
          s.userId,
          by,
          outcome,
          JSON.stringify(failed ? [] : kept),
          failed ? 0 : dropped,
          micro.toString(),
          usage.modelCalls,
        ],
      );
      await audit(
        tx,
        s,
        "thesis.challenge",
        `thesis:${id}`,
        { challengeId, outcome },
        orgId === s.principal.orgId ? (workspaceId ?? undefined) : undefined,
      );
      return ins.rows[0]!;
    });
    // The ACTUAL provider-priced USD of this call, charged once per challenge.
    await charge(s, usage.usd, challengeId, usage.modelCalls);
    return viewOfRow(row);
  });

  const charge = (s: Session, usd: number, challengeId: string, modelCalls: number) =>
    chargeModelUsd(kernel.db, ctxOf(s), usd, {
      refKind: "thesis_challenge",
      refId: challengeId,
      detail: { modelCalls },
    }).catch((err) => app.log.error({ err: (err as Error).message }, "charging the thesis challenge failed"));

  app.get<{ Params: { id: string } }>("/v1/theses/:id/challenges", async (req) => {
    const s = await authenticate(req);
    const id = req.params.id;
    await visibleDoc(s, id);
    const m = await kernel.db.tx(ctxOf(s), (tx) => readChallenges(tx, [id]));
    return { challenges: m.get(id) ?? [] };
  });

  app.post<{ Params: { id: string; cid: string } }>("/v1/theses/:id/challenges/:cid/answer", async (req) => {
    const s = await authenticate(req);
    const { id, cid } = req.params;
    const { text } = parseBody(AnswerBody, req.body);
    if (id === REFERENCE_ID)
      throw new KernelError(
        "VALIDATION_FAILED",
        "THESIS_IS_REFERENCE",
        "The reference thesis is pinned and has no owner to answer.",
      );
    const { orgId, workspaceId } = await visibleDoc(s, id);
    if (orgId !== s.principal.orgId) throw notFound();
    if (!canWrite(s.role))
      throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role cannot make this change.");
    const problem = answerProblem(text);
    if (problem)
      throw new KernelError(
        "VALIDATION_FAILED",
        "ANSWER_WORDING_REJECTED",
        "The answer failed the wording rules.",
        {
          details: [{ path: "text", issue: problem }],
        },
      );
    if (!Uuid.safeParse(cid).success) throw challengeNotFound();
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const cur = (
        await tx.query<{ outcome: string; answer: string | null }>(
          "SELECT outcome, answer FROM thesis_challenges WHERE id = $1 AND thesis_id = $2 FOR UPDATE",
          [cid, id],
        )
      ).rows[0];
      if (!cur) throw challengeNotFound();
      if (cur.outcome === "unavailable")
        throw new KernelError(
          "VALIDATION_FAILED",
          "CHALLENGE_NOT_ANSWERABLE",
          "This challenge produced no notes, so there is nothing to answer.",
        );
      if (cur.answer !== null)
        throw new KernelError(
          "VALIDATION_FAILED",
          "CHALLENGE_ALREADY_ANSWERED",
          "This challenge already has an answer.",
        );
      const up = await tx.query<ChallengeRow>(
        `UPDATE thesis_challenges SET answer = $3, answered_at = now() WHERE id = $1 AND thesis_id = $2
         RETURNING id, outcome, notes, dropped_notes, cost_usd_micro, model_calls, answer, answered_at, created_at, display_name`,
        [cid, id, text],
      );
      await audit(
        tx,
        s,
        "thesis.challenge.answer",
        `thesis:${id}`,
        { challengeId: cid },
        workspaceId ?? undefined,
      );
      return viewOfRow(up.rows[0]!);
    });
  });
};

const challengeNotFound = (): KernelError =>
  new KernelError("NOT_FOUND", "CHALLENGE_NOT_FOUND", "Challenge not found.");

(userThesisChallengeRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
