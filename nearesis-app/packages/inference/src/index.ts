import type { InferenceProvider } from "@nearesis/contracts";
import { MockInferenceProvider, type MockFixture } from "./mock.ts";
import { NearAiProvider, type NearAiOptions } from "./near-ai.ts";
import { loadEnvVar } from "./env.ts";
import { InferenceError } from "./errors.ts";

export { MockInferenceProvider, type MockFixture } from "./mock.ts";
export { NearAiProvider, type NearAiOptions, type ModelDiscovery, NEAR_AI_BASE_URL } from "./near-ai.ts";
export {
  verifyNearAiResult,
  verifyPreflight,
  type PreflightSummary,
  DEFAULT_TCB_STATUSES,
  type NearAiEvidence,
  type NearAiVerificationPolicy,
  type VerifyDeps,
} from "./near-verify.ts";
export {
  assertPublishable,
  evaluatePublication,
  REQUIRED_CHECKS,
  type GateDecision,
  type PublishableArtifact,
} from "./gate.ts";
export { InferenceError, redact, type InferenceErrorCode } from "./errors.ts";
export { validateWithRepair, MAX_REPAIR_ATTEMPTS } from "./structured.ts";
export { sha256Hex } from "./hash.ts";
export { loadDefaultPolicy } from "./policy.ts";
export { loadEnvVar } from "./env.ts";

export function createProvider(
  cfg: { mode: "mock"; fixtures?: MockFixture[] } | ({ mode: "near-ai" } & Partial<NearAiOptions>),
): InferenceProvider {
  if (cfg.mode === "mock") return new MockInferenceProvider({ fixtures: cfg.fixtures });
  const apiKey = cfg.apiKey ?? loadEnvVar("NEAR_AI_API_KEY");
  if (!apiKey) throw new InferenceError("UPSTREAM_DEGRADED", "NEAR_AI_API_KEY is not configured");
  return new NearAiProvider({ ...cfg, apiKey });
}
