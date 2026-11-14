import type { InferenceProvider } from "@nearesis/contracts";
import { MockInferenceProvider, type MockFixture } from "./mock.ts";
import { NearAiProvider, type NearAiOptions } from "./near-ai.ts";
import { OpenRouterProvider, type OpenRouterOptions } from "./openrouter.ts";
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
export { SpendLedger, MAX_BUDGET_USD, resolveBudgetUsd, credentialKey, defaultLedgerPath } from "./spend.ts";
export { NOT_PRODUCTION_APPROVED, PROVISIONAL_NOTE, PRODUCTION_APPROVED_PROVENANCE } from "./near-verify.ts";
export { loadDefaultPolicy } from "./policy.ts";
export {
  OpenRouterProvider,
  OPENROUTER_BASE_URL,
  RUN_TOKEN_CAP,
  classifyHttp,
  type OpenRouterOptions,
  type AttemptRecord,
  type FailureClass,
  type ModelValidation,
} from "./openrouter.ts";
export { loadEnvVar } from "./env.ts";

export type ProviderMode = "openrouter" | "mock" | "near-ai";

/** INFERENCE_PROVIDER selection: explicit value wins; otherwise openrouter when a key is present, else mock. */
export function resolveProviderMode(
  env: (n: string) => string | undefined = (n) => loadEnvVar(n),
): ProviderMode {
  const explicit = env("INFERENCE_PROVIDER")?.trim().toLowerCase();
  if (explicit === "openrouter" || explicit === "mock" || explicit === "near-ai") return explicit;
  return env("OPENROUTER_API_KEY") ? "openrouter" : "mock";
}

export function openRouterOptionsFromEnv(
  env: (n: string) => string | undefined = (n) => loadEnvVar(n),
): OpenRouterOptions {
  const list = (v: string | undefined) =>
    (v ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const apiKey = env("OPENROUTER_API_KEY");
  if (!apiKey) throw new InferenceError("UPSTREAM_AUTH", "OPENROUTER_API_KEY is not configured");
  const allowed = list(env("OPENROUTER_ALLOWED_PROVIDERS"));
  return {
    apiKey,
    primaryModel: env("OPENROUTER_PRIMARY_MODEL")?.trim() || undefined,
    fallbackModels: list(env("OPENROUTER_FALLBACK_MODELS")),
    allowedProviders: allowed.length ? allowed : ["openai", "anthropic"],
  };
}

export function createProvider(
  cfg:
    | { mode: "mock"; fixtures?: MockFixture[] }
    | ({ mode: "near-ai" } & Partial<NearAiOptions>)
    | ({ mode: "openrouter" } & Partial<OpenRouterOptions>),
): InferenceProvider {
  if (cfg.mode === "mock") return new MockInferenceProvider({ fixtures: cfg.fixtures });
  if (cfg.mode === "openrouter") {
    const { mode: _m, ...rest } = cfg;
    void _m;
    let fromEnv: Partial<OpenRouterOptions> = {};
    try {
      fromEnv = openRouterOptionsFromEnv();
    } catch (e) {
      if (!rest.apiKey) throw e;
    }
    return new OpenRouterProvider({ ...fromEnv, ...rest, apiKey: (rest.apiKey ?? fromEnv.apiKey)! });
  }
  const apiKey = cfg.apiKey ?? loadEnvVar("NEAR_AI_API_KEY");
  if (!apiKey) throw new InferenceError("UPSTREAM_DEGRADED", "NEAR_AI_API_KEY is not configured");
  return new NearAiProvider({ ...cfg, apiKey });
}

/** Provider chosen by environment (see resolveProviderMode). */
export function createProviderFromEnv(): InferenceProvider {
  return createProvider({ mode: resolveProviderMode() });
}
