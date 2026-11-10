import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SpendLedger,
  assertPublishable,
  classifyHttp,
  resolveProviderMode,
  createProvider,
  openRouterOptionsFromEnv,
} from "../src/index.ts";
import { KEY, makeFake, makeProvider } from "./support/openrouter-fake.ts";

const schema = z.object({ city: z.string(), population_millions: z.number() });
const base = {
  model: "openai/primary",
  system: "sys",
  prompt: "synthetic",
  schema,
  idempotencyKey: "k",
  maxTokens: 500,
};

describe("OpenRouterProvider", () => {
  it("successful structured inference: routing prefs, BYOK check, tracking, unattested", async () => {
    const f = makeFake();
    const { provider, ledger } = makeProvider(f);
    const r = await provider.generateStructured(base);
    expect(r.output).toEqual({ city: "Atlantis", population_millions: 1.5 });
    expect(r.provider).toBe("openrouter");
    const chat = f.calls.find((c) => c.path === "/chat/completions")!;
    expect(chat.body!.provider).toEqual({
      only: ["openai", "anthropic"],
      allow_fallbacks: false,
      require_parameters: true,
    });
    expect((chat.body!.response_format as { type: string }).type).toBe("json_schema");
    expect(f.calls.some((c) => c.path.startsWith("/generation?id=gen-"))).toBe(true);
    const ev = r.evidence as {
      byok: boolean;
      upstreamProvider: string;
      attempts: Array<{ outcome: string }>;
    };
    expect(ev.byok).toBe(true);
    expect(ev.upstreamProvider).toBe("OpenAI");
    expect(ev.attempts.map((a) => a.outcome)).toEqual(["ok"]);
    // ledger accounting: base = max(upstream 0.0004, 50*1e-6+20*4e-6=0.00013) + fee 0.00001
    const [e] = await ledger.entries();
    expect(e!.status).toBe("settled");
    expect(e!.actualUsd).toBeCloseTo(0.00041, 8);
    expect(e!.inputTokens).toBe(50);
    expect(e!.outputTokens).toBe(20);
    expect(e!.info).toMatchObject({
      model: "openai/primary",
      byok: true,
      httpStatus: 200,
      upstreamProvider: "OpenAI",
    });
    expect(typeof e!.info!.latencyMs).toBe("number");
    expect(await provider.verifyResponse()).toEqual({
      verified: false,
      status: "unsupported",
      checks: [],
      reason: "PROVIDER_HAS_NO_ATTESTATION",
    });
    expect(() => assertPublishable({ verification: await_(provider) })).toThrow(/PUBLICATION_REFUSED/);
  });

  it("malformed output is repaired by re-asking, then SCHEMA_INVALID after 2 repairs (and falls through the chain)", async () => {
    const f = makeFake();
    f.chat["openai/primary"] = [
      { content: "not json" },
      { content: JSON.stringify({ city: 1 }) },
      { content: JSON.stringify({ city: "ok", population_millions: 2 }) },
    ];
    const { provider } = makeProvider(f);
    const r = await provider.generateStructured(base);
    expect(r.output.city).toBe("ok");
    expect(f.calls.filter((c) => c.path === "/chat/completions")).toHaveLength(3);

    const f2 = makeFake();
    f2.chat["openai/primary"] = [{ content: "bad" }];
    f2.chat["anthropic/fallback"] = [{ content: "bad" }];
    const { provider: p2 } = makeProvider(f2);
    await expect(p2.generateStructured(base)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    expect(f2.calls.filter((c) => c.path === "/chat/completions")).toHaveLength(6); // 3 per model
  });

  it("classifies failure classes", () => {
    expect(classifyHttp(429).cls).toBe("rate_limited");
    expect(classifyHttp(503).cls).toBe("provider_unavailable");
    expect(classifyHttp(500).cls).toBe("server_error");
    expect(classifyHttp(404).cls).toBe("model_not_found");
    expect(classifyHttp(401)).toEqual({ cls: "auth", recoverable: false });
    expect(classifyHttp(403).recoverable).toBe(false);
    expect(classifyHttp(402)).toEqual({ cls: "billing", recoverable: false });
    expect(classifyHttp(400).recoverable).toBe(false);
    expect(classifyHttp(200, { error: { code: 429, message: "rate" } }).cls).toBe("rate_limited");
  });

  it("recoverable failure: one bounded retry then fallback model; attempt log records it", async () => {
    const f = makeFake();
    f.chat["openai/primary"] = [{ status: 429 }];
    const { provider } = makeProvider(f);
    const r = await provider.generateStructured(base);
    expect(r.model).toBe("anthropic/fallback");
    const ev = r.evidence as {
      modelUsed: string;
      modelRequested: string;
      attempts: Array<{ model: string; try: number; outcome: string }>;
    };
    expect(ev.modelRequested).toBe("openai/primary");
    expect(ev.attempts.map((a) => `${a.model}#${a.try}:${a.outcome}`)).toEqual([
      "openai/primary#0:rate_limited",
      "openai/primary#1:rate_limited",
      "anthropic/fallback#0:ok",
    ]);
    expect(f.calls.filter((c) => (c.body?.model as string) === "openai/primary")).toHaveLength(2);
  });

  it("timeout and 5xx are recoverable; empty completion falls back", async () => {
    const f = makeFake();
    f.chat["openai/primary"] = [{ throwAbort: true }];
    const { provider } = makeProvider(f);
    expect((await provider.generateStructured(base)).model).toBe("anthropic/fallback");
    const f2 = makeFake();
    f2.chat["openai/primary"] = [{ status: 502 }];
    expect((await makeProvider(f2).provider.generateStructured(base)).model).toBe("anthropic/fallback");
    const f3 = makeFake();
    f3.chat["openai/primary"] = [{ content: "" }];
    expect((await makeProvider(f3).provider.generateStructured(base)).model).toBe("anthropic/fallback");
  });

  it("nonexistent primary (forced fallback) falls back without a network send", async () => {
    const f = makeFake();
    const { provider } = makeProvider(f);
    const r = await provider.generateStructured({ ...base, model: "does-not/exist" });
    expect(r.model).toBe("anthropic/fallback");
    const ev = r.evidence as { attempts: Array<{ model: string; outcome: string; source: string }> };
    expect(ev.attempts[0]).toMatchObject({
      model: "does-not/exist",
      outcome: "model_not_found",
      source: "catalog",
    });
    expect(f.calls.some((c) => c.body?.model === "does-not/exist")).toBe(false);
  });

  it("a real 404 from the provider is model_not_found and falls back", async () => {
    const f = makeFake();
    f.chat["openai/primary"] = [{ status: 404 }];
    const { provider } = makeProvider(f);
    const r = await provider.generateStructured(base);
    expect(r.model).toBe("anthropic/fallback");
  });

  it("non-recoverable failures stop immediately without retry or fallback", async () => {
    for (const [status, code] of [
      [401, "UPSTREAM_AUTH"],
      [403, "UPSTREAM_AUTH"],
      [402, "UPSTREAM_BILLING"],
    ] as const) {
      const f = makeFake();
      f.chat["openai/primary"] = [{ status }];
      const { provider, ledger } = makeProvider(f);
      await expect(provider.generateStructured(base)).rejects.toMatchObject({ code, httpStatus: status });
      expect(f.calls.filter((c) => c.path === "/chat/completions")).toHaveLength(1);
      expect(await ledger.spentUsd()).toBe(0); // rejected before any cost
    }
  });

  it("BYOK check rejects a non-BYOK generation as a hard error and records it", async () => {
    const f = makeFake();
    f.generation = (id) => ({ data: { id, is_byok: false, provider_name: "OpenAI", total_cost: 0.0005 } });
    const { provider, ledger } = makeProvider(f);
    await expect(provider.generateStructured(base)).rejects.toMatchObject({
      code: "NOT_BYOK_SHARED_CAPACITY",
    });
    expect(f.calls.filter((c) => c.path === "/chat/completions")).toHaveLength(1); // no fallback
    const [e] = await ledger.entries();
    expect(e!.info).toMatchObject({ errorClass: "not_byok", byok: false });
    expect(e!.status).toBe("settled");
  });

  it("disallowed upstream provider or missing metadata is rejected", async () => {
    const f = makeFake();
    f.generation = (id) => ({ data: { id, is_byok: true, provider_name: "Azure" } });
    await expect(makeProvider(f).provider.generateStructured(base)).rejects.toMatchObject({
      code: "NOT_BYOK_SHARED_CAPACITY",
    });
    const f2 = makeFake();
    f2.generation = () => ({ status: 404 });
    await expect(makeProvider(f2).provider.generateStructured(base)).rejects.toMatchObject({
      code: "UPSTREAM_DEGRADED",
    });
  });

  it("budget refusal happens before sending and ledger accumulates", async () => {
    const f = makeFake();
    const small = new SpendLedger({ apiKey: KEY, path: makeProvider(f).ledger.path, capUsd: 0.0001 });
    const p = makeProvider(f, { ledger: small }).provider;
    await expect(p.generateStructured(base)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(f.calls.some((c) => c.path === "/chat/completions")).toBe(false);
    // cumulative: a cap that fits one call but not two
    const f2 = makeFake();
    const mk = makeProvider(f2);
    const cap = new SpendLedger({ apiKey: KEY, path: mk.ledger.path, capUsd: 0.004 });
    const p2 = makeProvider(f2, { ledger: cap }).provider;
    await p2.generateStructured({ ...base, maxTokens: 500 });
    let refused = false;
    for (let i = 0; i < 20 && !refused; i++) {
      try {
        await p2.generateStructured({ ...base, maxTokens: 500 });
      } catch (e) {
        refused = (e as { code: string }).code === "BUDGET_EXCEEDED";
        if (!refused) throw e;
      }
    }
    expect(refused).toBe(true);
    expect(await cap.spentUsd()).toBeLessThanOrEqual(0.004 + 1e-9);
  });

  it("per-run 20k token cap refuses", async () => {
    const f = makeFake();
    await expect(
      makeProvider(f).provider.generateStructured({ ...base, maxTokens: 25_000 }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("unknown pricing refuses rather than guesses", async () => {
    const f = makeFake();
    const { provider } = makeProvider(f, { primaryModel: "openai/no-price", fallbackModels: [] });
    await expect(provider.generateStructured({ ...base, model: "openai/no-price" })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
  });

  it("refuses a configured model lacking structured outputs or tools before any completion", async () => {
    const f = makeFake();
    const { provider } = makeProvider(f, { fallbackModels: ["openai/no-tools"] });
    await expect(provider.generateStructured(base)).rejects.toMatchObject({ code: "MODEL_UNSUPPORTED" });
    expect(f.calls.some((c) => c.path === "/chat/completions")).toBe(false);
    const rep = await provider.validateModels(["openai/primary", "openai/no-tools", "x/missing"]);
    expect(rep.map((r) => r.supported)).toEqual([true, false, false]);
    expect((await provider.listModels()).find((m) => m.id === "openai/primary")!.outputModes).toContain(
      "json_schema",
    );
  });

  it("never leaks the key in errors, ledger, evidence or request logs", async () => {
    const f = makeFake();
    f.chat["openai/primary"] = [{ status: 401, body: { error: { code: 401, message: `bad key ${KEY}` } } }];
    const { provider, ledger } = makeProvider(f);
    let msg = "";
    try {
      await provider.generateStructured(base);
    } catch (e) {
      msg = String((e as Error).message) + JSON.stringify(provider.attempts);
    }
    expect(msg).not.toContain(KEY);
    expect(JSON.stringify(await ledger.entries())).not.toContain(KEY);
    const ok = makeFake();
    const mk = makeProvider(ok);
    const r = await mk.provider.generateStructured(base);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(await mk.ledger.entries())).not.toContain(KEY);
  });
});

function await_(p: { verifyResponse: () => Promise<unknown> }) {
  // synchronous helper for the unsupported verification shape
  void p;
  return {
    verified: false,
    status: "unsupported" as const,
    checks: [],
    reason: "PROVIDER_HAS_NO_ATTESTATION",
  };
}

describe("provider selection from env", () => {
  it("defaults mock without key, openrouter with key, near-ai only explicit", () => {
    const env = (m: Record<string, string>) => (n: string) => m[n];
    expect(resolveProviderMode(env({}))).toBe("mock");
    expect(resolveProviderMode(env({ OPENROUTER_API_KEY: "k" }))).toBe("openrouter");
    expect(resolveProviderMode(env({ OPENROUTER_API_KEY: "k", INFERENCE_PROVIDER: "near-ai" }))).toBe(
      "near-ai",
    );
    expect(resolveProviderMode(env({ INFERENCE_PROVIDER: "mock", OPENROUTER_API_KEY: "k" }))).toBe("mock");
    const o = openRouterOptionsFromEnv(
      env({
        OPENROUTER_API_KEY: "k",
        OPENROUTER_PRIMARY_MODEL: "a/b",
        OPENROUTER_FALLBACK_MODELS: "c/d, e/f",
      }),
    );
    expect(o.fallbackModels).toEqual(["c/d", "e/f"]);
    expect(o.allowedProviders).toEqual(["openai", "anthropic"]);
    expect(createProvider({ mode: "openrouter", apiKey: "k", primaryModel: "a/b" }).id).toBe("openrouter");
  });
});
