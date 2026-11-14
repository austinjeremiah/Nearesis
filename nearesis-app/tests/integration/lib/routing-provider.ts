import type { InferenceProvider, StructuredResult, VerificationResult } from "@nearesis/contracts";
import type { z } from "zod";
import { ScriptedProvider } from "../../../packages/agent-runtime/src/testing/scripted-provider.ts";
import { scenarioRules } from "../../../packages/agent-runtime/src/testing/scenarios.ts";

/**
 * Keeps scripted scenarios scripted while a live question uses the real provider: a call whose system or prompt text carries
 * `[scenario=<name>]` (name other than `none`) is answered by the scripted rules, everything else by `real`. Used only when a
 * test opts into live inference; mock/scripted inference remains the default everywhere else.
 */
export class ScenarioRoutingProvider implements InferenceProvider {
  readonly id: string;
  readonly scripted = new ScriptedProvider(scenarioRules({ stepDelayMs: 0 }));
  /** Calls answered by the real provider (for the evidence line). */
  realCalls = 0;
  scriptedCalls = 0;
  constructor(private readonly real: InferenceProvider) {
    this.id = real.id;
  }
  private isScripted(a: { system: string; prompt: string }): boolean {
    return /\[scenario=(?!none\])/.test(`${a.system}\n${a.prompt}`);
  }
  health() {
    return this.real.health();
  }
  listModels() {
    return this.real.listModels();
  }
  generateStructured<T>(args: {
    model: string;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    idempotencyKey: string;
    maxTokens: number;
  }): Promise<StructuredResult<T>> {
    return this.pick(args).generateStructured<T>(args);
  }
  streamText(args: Parameters<InferenceProvider["streamText"]>[0]) {
    return this.pick(args).streamText(args);
  }
  verifyResponse(result: StructuredResult<unknown>): Promise<VerificationResult> {
    return this.real.verifyResponse(result);
  }
  private pick(a: { system: string; prompt: string }): InferenceProvider {
    if (this.isScripted(a)) {
      this.scriptedCalls++;
      return this.scripted;
    }
    this.realCalls++;
    return this.real;
  }
}
