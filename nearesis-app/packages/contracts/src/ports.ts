import type { z } from "zod";
import type { ExecutionRequest, ExecutionResponse } from "./plugin.ts";
import type { Principal } from "./identity.ts";

/**
 * Agent tool gateway (ch.04 internal execution path). Implemented by @nearesis/kernel; consumed by agent-runtime.
 * The gateway resolves authoritative grants server-side; callers never supply authority.
 */
export interface ToolGateway {
  invoke(principal: Principal, request: ExecutionRequest): Promise<ExecutionResponse>;
}

export interface AttestationCheck {
  name:
    "tdx_quote_non_debug" | "measurement_accepted" | "signer_match" | "evidence_fresh" | "response_binding";
  passed: boolean;
  detail: string;
}
export interface VerificationResult {
  verified: boolean;
  /** "unattested_dev" for the mock provider (ch.12); "unsupported" when the provider path offers no attestation. */
  status: "verified" | "failed" | "unattested_dev" | "unsupported";
  checks: AttestationCheck[];
  reason?: string;
}
export interface StructuredResult<T> {
  output: T;
  provider: string;
  model: string;
  requestId: string | null;
  usage: { inputTokens: number; outputTokens: number };
  /** Opaque, provider-specific evidence needed by verifyResponse. */
  evidence: unknown;
  rawResponseSha256: string;
}

/** ch.05 inference adapter interface (A15/A16). */
export interface InferenceProvider {
  readonly id: string;
  health(): Promise<{ ok: boolean; detail: string }>;
  listModels(): Promise<
    Array<{ id: string; attestation: "supported" | "unsupported" | "unknown"; outputModes: string[] }>
  >;
  generateStructured<T>(args: {
    model: string;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    idempotencyKey: string;
    maxTokens: number;
  }): Promise<StructuredResult<T>>;
  streamText(args: {
    model: string;
    system: string;
    prompt: string;
    maxTokens: number;
  }): AsyncIterable<string>;
  verifyResponse(result: StructuredResult<unknown>): Promise<VerificationResult>;
}
