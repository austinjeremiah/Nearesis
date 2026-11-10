import { describe, expect, it } from "vitest";
import { z } from "zod";
import { observe } from "@nearesis/acceptance";
import {
  InferenceError,
  OpenRouterProvider,
  assertPublishable,
  loadEnvVar,
  openRouterOptionsFromEnv,
  sha256Hex,
  MAX_BUDGET_USD,
} from "../../src/index.ts";
import { a21OutcomeForError } from "../support/a21-mapping.ts";

const TOKEN_CAP = 20_000;
const PROBE = {
  system: "You return JSON only.",
  prompt:
    "Synthetic probe with no real data: invent a fictional city name and a made-up population in millions.",
};
const schema = z.object({ city: z.string().min(1), population_millions: z.number() });
const FORCED_BAD_MODEL = "nearesis-a21/nonexistent-model";

describe("A21 provider-neutral live structured inference (OpenRouter BYOK)", () => {
  it("discovery, primary, forced fallback, BYOK, cost ledger, unattested, no key leak", async () => {
    const fixtureHash = sha256Hex(JSON.stringify([PROBE, JSON.stringify(z.toJSONSchema(schema))]));
    const blocked = (reason: string, evidence?: Record<string, unknown>) =>
      observe({ testId: "A21", observed: reason, fixtureHash, blocked: reason, evidence });

    const key = loadEnvVar("OPENROUTER_API_KEY");
    if (process.env.NEARESIS_ACCEPT_LIVE !== "1")
      return blocked("NEARESIS_ACCEPT_LIVE != 1 (--live not given)");
    if (!key) return blocked("OPENROUTER_API_KEY not present (BLOCKED_DEPENDENCY)");
    const opts = openRouterOptionsFromEnv();
    if (!opts.primaryModel || (opts.fallbackModels ?? []).length === 0) {
      return blocked("OPENROUTER_PRIMARY_MODEL and at least one OPENROUTER_FALLBACK_MODELS are required");
    }
    const p = new OpenRouterProvider(opts);
    const policy = {
      allowedProviders: p.allowedProviders,
      models: [opts.primaryModel, ...(opts.fallbackModels ?? [])],
    };
    const budgetBefore = await p.spend.remainingUsd();

    // 1. discovery + validation (a)
    const discovery = await p.validateModels(policy.models);
    const unsupported = discovery.filter((d) => !d.supported);
    if (unsupported.length > 0) {
      // an unsupported model is refused before use; verify that refusal is real
      await expect(
        p.generateStructured({
          model: opts.primaryModel,
          ...PROBE,
          schema,
          idempotencyKey: "A21-refuse",
          maxTokens: 2000, // reasoning models spend hidden tokens before the answer; 400 yielded empty completions
        }),
      ).rejects.toMatchObject({
        code: "MODEL_UNSUPPORTED",
      });
      return blocked(
        `configured model(s) unsupported (refused before use): ${unsupported.map((u) => u.id).join(", ")}`,
        { discovery },
      );
    }

    const calls: Array<{
      label: string;
      result?: Awaited<ReturnType<typeof p.generateStructured>>;
      attempts: unknown;
    }> = [];
    const run = async (label: string, model: string) => {
      const result = await p.generateStructured({
        model,
        ...PROBE,
        schema,
        idempotencyKey: `A21-${label}`,
        maxTokens: 2000, // reasoning models spend hidden tokens before the answer; 400 yielded empty completions
      });
      calls.push({ label, result, attempts: structuredClone(p.attempts) });
      return result;
    };

    let primary, fallback;
    try {
      // 2. primary (b)
      primary = await run("primary", opts.primaryModel);
      // 3. forced fallback (c)
      fallback = await run("forced-fallback", FORCED_BAD_MODEL);
    } catch (e) {
      if (e instanceof InferenceError) {
        const m = a21OutcomeForError(e.code);
        if (m.outcome !== "RETHROW") {
          const evidence = {
            discovery,
            attempts: p.attempts,
            ledger: await p.spend.entries(),
            keyLeakCount: 0,
          };
          const text = `${m.reason}: ${e.message.replace(key, "[REDACTED]")}`;
          if (m.outcome === "BLOCKED_DEPENDENCY") return blocked(text, evidence);
          // non-BYOK response spent outside the owner's BYOK credits: FAIL (16a section 7 clarification ii)
          observe({ testId: "A21", observed: text, fixtureHash, evidence });
          expect.fail(text);
        }
      }
      throw e;
    }

    // (b)
    for (const r of [primary, fallback]) expect(schema.safeParse(r.output).success).toBe(true);
    // (c)
    const fbEvidence = fallback.evidence as {
      modelUsed: string;
      attempts: Array<{ model: string; outcome: string }>;
    };
    expect(fbEvidence.attempts[0]).toMatchObject({ model: FORCED_BAD_MODEL, outcome: "model_not_found" });
    expect(opts.fallbackModels).toContain(fbEvidence.modelUsed);
    expect(fallback.model).toBe(fbEvidence.modelUsed);
    // (d)
    for (const r of [primary, fallback]) {
      const ev = r.evidence as { byok: boolean; generation: { is_byok: boolean; provider_name: string } };
      expect(ev.byok).toBe(true);
      expect(ev.generation.is_byok).toBe(true);
      expect(p.allowedProviders.map((a) => a.toLowerCase())).toContain(
        ev.generation.provider_name.toLowerCase().replace(/[^a-z0-9]/g, ""),
      );
    }
    // (e)
    const entries = await p.spend.entries();
    const settled = entries.filter((e) => e.status === "settled");
    expect(settled.length).toBeGreaterThanOrEqual(2);
    for (const e of settled) {
      expect(e.model).toBeTruthy();
      expect(e.inputTokens).toBeGreaterThan(0);
      expect(e.outputTokens).toBeGreaterThan(0);
      expect(e.actualUsd).not.toBeNull();
      expect(e.info).toMatchObject({ httpStatus: 200 });
      expect(typeof e.info!.latencyMs).toBe("number");
      expect(e.info!.upstreamProvider).toBeTruthy();
    }
    const spent = await p.spend.spentUsd();
    expect(spent).toBeLessThanOrEqual(MAX_BUDGET_USD);
    expect(p.tokensUsed).toBeLessThanOrEqual(TOKEN_CAP);
    // (f)
    const verifications = [] as unknown[];
    for (const r of [primary, fallback]) {
      const v = await p.verifyResponse();
      verifications.push(v);
      expect(v.verified).toBe(false);
      expect(v.status).toBe("unsupported");
      expect(() => assertPublishable({ verification: v })).toThrow(/PUBLICATION_REFUSED/);
      expect(r.provider).toBe("openrouter");
    }
    const evidence = {
      discovery,
      allowedProviders: policy.allowedProviders,
      responses: calls.map((c) => ({
        label: c.label,
        model: c.result!.model,
        requestId: c.result!.requestId,
        usage: c.result!.usage,
        output: c.result!.output,
        evidence: c.result!.evidence,
      })),
      ledger: entries,
      verifications,
      budgetRemainingUsdBefore: budgetBefore,
      budgetRemainingUsdAfter: await p.spend.remainingUsd(),
      cumulativeSpendUsd: spent,
      runTokens: p.tokensUsed,
      runCostUsd: p.usdSpentThisRun,
      keyLeakCount: 0,
    };
    // (g)
    const serialised = JSON.stringify(evidence);
    expect(serialised.includes(key)).toBe(false);
    observe({
      testId: "A21",
      observed: `${discovery.length} configured models supported (structured_outputs+tools); primary ${primary.model} schema-valid; forced fallback from ${FORCED_BAD_MODEL} (model_not_found) to ${fallback.model} schema-valid; both generations is_byok=true from allowed providers; ledger rows ${settled.length} with tokens/cost/latency/http status; cumulative spend USD ${spent.toFixed(6)} <= ${MAX_BUDGET_USD}; run tokens ${p.tokensUsed}/${TOKEN_CAP}; verification status unsupported, assertPublishable refused; key occurrences 0`,
      fixtureHash,
      evidence,
    });
  }, 300_000);
});
