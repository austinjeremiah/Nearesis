import type { z } from "zod";
import type { InferenceProvider, StructuredResult } from "@nearesis/contracts";
import type pg from "pg";
import {
  containsSecretShape,
  guardInference,
  isGuardedInference,
  modelPolicyFromEnv,
  scrubSecretShapes,
} from "@nearesis/kernel";
import { AbortedError, runExternalEffect } from "./ledger.ts";
import { usdForTokens, type Supervisor } from "./supervisor.ts";
import type { CostGovernor } from "./cost/governor.ts";

export interface InferenceCtx {
  tenantId: string;
  workspaceId: string;
  runId: string;
  budgetId: string;
  taskId: string;
  model: string;
  signal?: AbortSignal;
  /**
   * Called once per delivered provider result, before the output is scrubbed and stored, so a verifier can record the
   * result's verification state (FND-072). A failure here never fails the call: the result then simply stays unverified.
   */
  onProviderResult?: (e: { key: string; result: StructuredResult<unknown> }) => Promise<void>;
}

/**
 * Inference wrapper with exactly-once ACCEPTANCE for a provider that offers no idempotency key (A20 c).
 * The durable result record keyed by the deterministic request key is checked before calling and written before the
 * activity continues; the charge is keyed too, so exactly one result per key is charged. Provider deliveries are
 * counted in `agent_side_effects.provider_calls` (at-least-once delivery disclosure).
 */
/** The priced actual a provider reports in its evidence (`estimatedCostUsd`), or null when it reports none (mock, local). */
export function actualCostUsd(evidence: unknown): number | null {
  const v = (evidence as { estimatedCostUsd?: unknown } | null | undefined)?.estimatedCostUsd;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export class LedgerInference {
  private readonly provider: InferenceProvider;
  constructor(
    provider: InferenceProvider,
    private readonly pool: pg.Pool,
    private readonly supervisor: Supervisor,
    private readonly ctx: InferenceCtx,
    /** Optional spend governor (ch.13 cost model): authorises BEFORE the provider is called, settles after. */
    private readonly cost?: CostGovernor,
  ) {
    // FND-073: no model call leaves this class unguarded, whatever provider the caller passed.
    this.provider = isGuardedInference(provider) ? provider : guardInference(provider, modelPolicyFromEnv());
  }

  async generate<T>(a: {
    key: string;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    maxTokens?: number;
  }): Promise<T> {
    const c = this.ctx;
    const out = await this.guarded(a, () =>
      runExternalEffect(
        this.pool,
        {
          tenantId: c.tenantId,
          runId: c.runId,
          effectKey: `inference:${a.key}`,
          kind: "inference",
          guarantee: "external_non_idempotent",
        },
        async () => {
          const r = await this.provider.generateStructured({
            model: c.model,
            system: a.system,
            prompt: a.prompt,
            schema: a.schema,
            idempotencyKey: a.key,
            maxTokens: a.maxTokens ?? 2000,
          });
          try {
            await c.onProviderResult?.({ key: a.key, result: r as StructuredResult<unknown> });
          } catch {
            // fail closed on the label: no recorded state means `unverified`
          }
          // ch.12: a model response is untrusted. Credential shapes (plain, base64, split by invisible characters) are
          // scrubbed BEFORE the durable record is written, so neither the ledger nor any later replay can carry them.
          const secretsRedacted = containsSecretShape(r.output);
          return {
            output: scrubSecretShapes(r.output) as unknown,
            usage: r.usage,
            // The provider's own priced actual (e.g. OpenRouter `total_cost`), null when it reports none. The run budget must
            // charge this, not the dev token price, or it reads ~10x the provider's ledger.
            costUsd: actualCostUsd(r.evidence),
            provider: r.provider,
            model: r.model,
            secretsRedacted,
          };
        },
        { signal: c.signal },
      ),
    );
    const tokens = out.result.usage.inputTokens + out.result.usage.outputTokens;
    await this.supervisor.charge({
      tenantId: c.tenantId,
      workspaceId: c.workspaceId,
      runId: c.runId,
      budgetId: c.budgetId,
      taskId: c.taskId,
      entryKey: `charge:${a.key}`,
      usage: { tokens, toolCalls: 0, usd: out.result.costUsd ?? usdForTokens(tokens) },
    });
    return a.schema.parse(out.result.output);
  }

  /**
   * Cost control (ch.13): authorise the worst-case spend BEFORE the provider is called (a refused spend never reaches
   * the provider), run the call, then settle with the actual tokens. A failed call returns its reservation, except an
   * aborted call, which may already have reached the provider and keeps the worst-case reservation.
   */
  private async guarded<
    R extends { result: { usage: { inputTokens: number; outputTokens: number }; costUsd?: number | null } },
  >(
    a: { key: string; system: string; prompt: string; maxTokens?: number },
    run: () => Promise<R>,
  ): Promise<R> {
    const cost = this.cost;
    if (!cost) return run();
    const c = this.ctx;
    const tokenKey = `cost:inference:${a.key}`;
    const reqKey = `cost:inference-req:${a.key}`;
    const estTokens = Math.ceil((a.system.length + a.prompt.length) / 4) + (a.maxTokens ?? 2000);
    const base = { tenantId: c.tenantId, workspaceId: c.workspaceId, runId: c.runId };
    await cost.authorize({
      ...base,
      key: reqKey,
      dimension: "external_requests",
      quantity: 1,
      paidOp: "inference",
    });
    try {
      await cost.authorize({
        ...base,
        key: tokenKey,
        dimension: "ai_tokens",
        quantity: estTokens,
        usd: usdForTokens(estTokens),
        paidOp: "inference",
      });
    } catch (e) {
      await cost.release(c.tenantId, reqKey);
      throw e;
    }
    let out: R;
    try {
      out = await run();
    } catch (e) {
      if (!(e instanceof AbortedError)) {
        await cost.release(c.tenantId, tokenKey);
        await cost.release(c.tenantId, reqKey);
      }
      throw e;
    }
    const tokens = out.result.usage.inputTokens + out.result.usage.outputTokens;
    await cost.settle(c.tenantId, tokenKey, {
      quantity: tokens,
      usd: out.result.costUsd ?? usdForTokens(tokens),
    });
    await cost.settle(c.tenantId, reqKey, { quantity: 1, usd: 0 });
    return out;
  }
}
