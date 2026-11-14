import type { z } from "zod";
import type { InferenceProvider, StructuredResult, VerificationResult } from "@nearesis/contracts";
import { hashOf } from "../canonical.ts";

export interface ScriptedRequest {
  model: string;
  system: string;
  prompt: string;
  idempotencyKey: string;
  maxTokens: number;
}
export interface ScriptRule {
  /** First matching rule wins. */
  match: (r: ScriptedRequest) => boolean;
  respond: (r: ScriptedRequest, nth: number) => unknown | Promise<unknown>;
  /** Simulated provider latency (the window in which a worker kill is a "crash inside the call"). */
  delayMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Deterministic scripted InferenceProvider for tests (the lead's mock/NEAR adapters plug into the same interface).
 * Output is validated against the caller's schema, so a script can deliberately violate it. Labelled unattested_dev.
 */
export class ScriptedProvider implements InferenceProvider {
  readonly id = "scripted";
  /** Provider-side delivery counter per idempotency key (A20 c at-least-once disclosure). */
  readonly deliveries = new Map<string, number>();
  private readonly nth = new Map<number, number>();
  constructor(private readonly rules: ScriptRule[]) {}

  async health() {
    return { ok: true, detail: "scripted" };
  }
  async listModels() {
    return [{ id: "scripted-1", attestation: "unsupported" as const, outputModes: ["json"] }];
  }

  async generateStructured<T>(args: {
    model: string;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    idempotencyKey: string;
    maxTokens: number;
  }): Promise<StructuredResult<T>> {
    this.deliveries.set(args.idempotencyKey, (this.deliveries.get(args.idempotencyKey) ?? 0) + 1);
    const idx = this.rules.findIndex((r) => r.match(args));
    if (idx < 0) throw new Error(`scripted provider: no rule for key ${args.idempotencyKey}`);
    const rule = this.rules[idx]!;
    const n = (this.nth.get(idx) ?? 0) + 1;
    this.nth.set(idx, n);
    if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
    const raw = await rule.respond(args, n);
    const output = args.schema.parse(raw);
    return {
      output,
      provider: "scripted",
      model: args.model,
      requestId: null,
      usage: rule.usage ?? { inputTokens: 100, outputTokens: 50 },
      evidence: null,
      rawResponseSha256: hashOf(raw),
    };
  }

  // eslint-disable-next-line require-yield
  async *streamText(): AsyncIterable<string> {
    throw new Error("scripted provider does not stream");
  }
  async verifyResponse(): Promise<VerificationResult> {
    return { verified: false, status: "unattested_dev", checks: [], reason: "SCRIPTED_PROVIDER" };
  }
}
