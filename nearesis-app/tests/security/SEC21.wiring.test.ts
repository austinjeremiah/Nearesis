/**
 * FND-073 production wiring. No production model call path bypasses `guardInference`: the entry points are enumerated
 * from the source tree, so a new call site, provider construction or direct model-endpoint fetch fails this test until
 * it is routed through the guard (or deliberately added to the allow-lists below with a reason).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isGuardedInference, KernelError, withDataLabel } from "../../packages/kernel/src/index.ts";
import { createRuntimeProvider } from "../../packages/workflow/src/kernel-deps.ts";

const ROOT = join(import.meta.dirname, "../..");
const SKIP = new Set(["node_modules", "dist", ".next", "test", "tests", "fixtures", ".data", ".toolchain"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n) || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p);
  }
  return out;
}
const prod = ["apps", "packages", "services", "plugins", "scripts", "tools"].flatMap((d) => {
  try {
    return sources(join(ROOT, d));
  } catch {
    return [];
  }
});
const rel = (p: string) => relative(ROOT, p);
const withText = (re: RegExp) =>
  prod
    .filter((p) => re.test(readFileSync(p, "utf8")))
    .map(rel)
    .sort();

describe("no production model call bypasses the guard", () => {
  it("only three places invoke a provider's generateStructured/streamText: the guard, LedgerInference and the composer", () => {
    expect(withText(/\.(generateStructured|streamText)\(/)).toEqual([
      "packages/agent-runtime/src/inference.ts", // LedgerInference: wraps its provider with guardInference in the constructor
      "packages/kernel/src/classification.ts", // the guard itself
      "plugins/near-thesis/src/composer.ts", // refuses any provider not marked guarded
    ]);
    const li = readFileSync(join(ROOT, "packages/agent-runtime/src/inference.ts"), "utf8");
    expect(li).toMatch(/guardInference\(provider, modelPolicyFromEnv\(\)\)/);
    const composer = readFileSync(join(ROOT, "plugins/near-thesis/src/composer.ts"), "utf8");
    expect(composer).toMatch(/UNGUARDED_INFERENCE_PROVIDER/);
    // and the composer's check happens before its single generateStructured call
    expect(composer.indexOf("UNGUARDED_INFERENCE_PROVIDER")).toBeLessThan(
      composer.indexOf(".generateStructured("),
    );
  });

  it("concrete providers are constructed in exactly one factory, and the factory is consumed only by the guarded runtime provider", () => {
    expect(withText(/new (OpenRouterProvider|NearAiProvider|MockInferenceProvider)\(/)).toEqual([
      "packages/inference/src/index.ts",
    ]);
    expect(withText(/\b(createProviderFromEnv|createProvider)\(/)).toEqual([
      "packages/inference/src/index.ts",
      "packages/workflow/src/kernel-deps.ts",
    ]);
    const deps = readFileSync(join(ROOT, "packages/workflow/src/kernel-deps.ts"), "utf8");
    expect(deps).toMatch(/guardInference\(createProviderFromEnv\(\), modelPolicyFromEnv\(\)\)/);
  });

  it("no source outside the inference package talks to a model endpoint directly, and every workflow call is routed through one guarded egress", () => {
    expect(withText(/openrouter\.ai|cloud-api\.near\.ai|api\.openai\.com|api\.anthropic\.com/)).toEqual([
      "packages/inference/src/near-ai.ts",
      "packages/inference/src/openrouter.ts",
    ]);
    const act = readFileSync(join(ROOT, "packages/workflow/src/activities.ts"), "utf8");
    expect(act).toMatch(/const egress = guardInference\(d\.provider, modelPolicyFromEnv\(\)\)/);
    expect(act).not.toMatch(/new LedgerInference\(\s*d\.provider/);
    expect(act.match(/new LedgerInference\(\s*egress\b/g)).toHaveLength(2);
  });

  it("the production provider is guarded, refuses private content for an unapproved binding, and logs a typed refusal", async () => {
    process.env.INFERENCE_PROVIDER = "mock";
    process.env.NEARESIS_APPROVED_MODEL_BINDINGS = "near-ai";
    const p = createRuntimeProvider();
    expect(isGuardedInference(p)).toBe(true);
    const args = {
      model: "mock",
      system: "s",
      prompt: "PRIVATE-SECRET-NOTE-zzz",
      schema: { parse: (x: unknown) => x } as never,
      idempotencyKey: "k",
      maxTokens: 10,
    };
    const err = await p.generateStructured(args).catch((e) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect(err).toMatchObject({
      code: "FORBIDDEN",
      reasonCode: "CLASSIFICATION_DENIED",
      opts: { retryable: false },
    });
    expect(() => p.streamText({ model: "mock", system: "s", prompt: "x" } as never)).toThrow(KernelError);
    // declared public content gets past the guard to the provider (the mock may then fail on its own fixtures)
    const pub = await withDataLabel("public", () => p.generateStructured(args)).catch((e) => e);
    expect(pub).not.toMatchObject({ reasonCode: "CLASSIFICATION_DENIED" });
  });
});

afterEach(() => {
  delete process.env.NEARESIS_APPROVED_MODEL_BINDINGS;
  delete process.env.INFERENCE_PROVIDER;
});
