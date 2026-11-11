import type { z } from "zod";
import type { InferenceProvider } from "@nearesis/contracts";
import type pg from "pg";
import { containsSecretShape, scrubSecretShapes } from "@nearesis/kernel";
import { runExternalEffect } from "./ledger.ts";
import { usdForTokens, type Supervisor } from "./supervisor.ts";

export interface InferenceCtx {
  tenantId: string;
  workspaceId: string;
  runId: string;
  budgetId: string;
  taskId: string;
  model: string;
  signal?: AbortSignal;
}

/**
 * Inference wrapper with exactly-once ACCEPTANCE for a provider that offers no idempotency key (A20 c).
 * The durable result record keyed by the deterministic request key is checked before calling and written before the
 * activity continues; the charge is keyed too, so exactly one result per key is charged. Provider deliveries are
 * counted in `agent_side_effects.provider_calls` (at-least-once delivery disclosure).
 */
export class LedgerInference {
  constructor(
    private readonly provider: InferenceProvider,
    private readonly pool: pg.Pool,
    private readonly supervisor: Supervisor,
    private readonly ctx: InferenceCtx,
  ) {}

  async generate<T>(a: {
    key: string;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    maxTokens?: number;
  }): Promise<T> {
    const c = this.ctx;
    const out = await runExternalEffect(
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
        // ch.12: a model response is untrusted. Credential shapes (plain, base64, split by invisible characters) are
        // scrubbed BEFORE the durable record is written, so neither the ledger nor any later replay can carry them.
        const secretsRedacted = containsSecretShape(r.output);
        return {
          output: scrubSecretShapes(r.output) as unknown,
          usage: r.usage,
          provider: r.provider,
          model: r.model,
          secretsRedacted,
        };
      },
      { signal: c.signal },
    );
    const tokens = out.result.usage.inputTokens + out.result.usage.outputTokens;
    await this.supervisor.charge({
      tenantId: c.tenantId,
      workspaceId: c.workspaceId,
      runId: c.runId,
      budgetId: c.budgetId,
      taskId: c.taskId,
      entryKey: `charge:${a.key}`,
      usage: { tokens, toolCalls: 0, usd: usdForTokens(tokens) },
    });
    return a.schema.parse(out.result.output);
  }
}
