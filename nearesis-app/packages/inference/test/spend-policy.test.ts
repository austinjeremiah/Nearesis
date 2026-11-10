import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_BUDGET_USD,
  NearAiProvider,
  NOT_PRODUCTION_APPROVED,
  PROVISIONAL_NOTE,
  SpendLedger,
  assertPublishable,
  credentialKey,
  loadDefaultPolicy,
  resolveBudgetUsd,
  verifyNearAiResult,
} from "../src/index.ts";
import { buildFixture, cloneResult } from "./support/near-fixture.ts";
import { z } from "zod";

const tmp = () => join(mkdtempSync(join(tmpdir(), "spend-")), "near-ai.json");

describe("budget cap resolution", () => {
  it("defaults to 5.00, can only be lowered", () => {
    expect(MAX_BUDGET_USD).toBe(5);
    expect(resolveBudgetUsd(undefined)).toBe(5);
    expect(resolveBudgetUsd("1.25")).toBe(1.25);
    expect(resolveBudgetUsd("100")).toBe(5);
    expect(resolveBudgetUsd("garbage")).toBe(5);
    expect(new SpendLedger({ apiKey: "k", path: tmp(), capUsd: 50 }).capUsd).toBe(5);
  });
});

describe("spend ledger", () => {
  it("accounts reserve, settle, release and stores only the credential hash", async () => {
    const path = tmp();
    const l = new SpendLedger({ apiKey: "secret-key-123456", path });
    expect(await l.remainingUsd()).toBe(5);
    const a = await l.reserve("m", 1.5);
    expect(await l.remainingUsd()).toBeCloseTo(3.5);
    await l.settle(a, { usd: 0.4, inputTokens: 10, outputTokens: 20, requestId: "r1" });
    expect(await l.spentUsd()).toBeCloseTo(0.4);
    const b = await l.reserve("m", 2);
    await l.release(b);
    expect(await l.spentUsd()).toBeCloseTo(0.4);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("secret-key-123456");
    expect(raw).toContain(credentialKey("secret-key-123456"));
    // another credential has its own budget
    expect(await new SpendLedger({ apiKey: "other", path }).remainingUsd()).toBe(5);
  });
  it("refuses a reservation exceeding the remaining budget", async () => {
    const l = new SpendLedger({ apiKey: "k", path: tmp(), capUsd: 1 });
    await l.reserve("m", 0.9);
    await expect(l.reserve("m", 0.2)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await l.spentUsd()).toBeCloseTo(0.9);
  });
  it("serialises concurrent reservations", async () => {
    const l = new SpendLedger({ apiKey: "k", path: tmp(), capUsd: 1 });
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => l.reserve("m", 0.3)));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  });
});

describe("provider budget enforcement", () => {
  const args = {
    model: "m",
    system: "s",
    prompt: "p",
    schema: z.object({ a: z.string() }),
    idempotencyKey: "k",
    maxTokens: 1000,
  };
  const never: typeof fetch = async () => {
    throw new Error("network must not be touched");
  };
  it("refuses before sending when worst case exceeds remaining", async () => {
    const ledger = new SpendLedger({ apiKey: "k", path: tmp(), capUsd: 0.001 });
    const p = new NearAiProvider({
      apiKey: "k",
      ledger,
      fetch: never,
      pricing: async () => ({ input: 1e-6, output: 1e-5 }),
    });
    await expect(p.generateStructured(args)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
  it("refuses when pricing is unavailable", async () => {
    const ledger = new SpendLedger({ apiKey: "k", path: tmp() });
    const p = new NearAiProvider({ apiKey: "k", ledger, fetch: never, pricing: async () => null });
    await expect(p.generateStructured(args)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await ledger.spentUsd()).toBe(0);
  });
  it("reads published pricing from the model endpoint (amount / 10^scale)", async () => {
    const f: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          inputCostPerToken: { amount: 2000, scale: 9 },
          outputCostPerToken: { amount: 10000, scale: 9 },
        }),
      );
    const p = new NearAiProvider({
      apiKey: "k",
      ledger: new SpendLedger({ apiKey: "k", path: tmp() }),
      fetch: f,
    });
    expect(await p.modelPricing("x")).toEqual({ input: 2e-6, output: 1e-5 });
    const bad = new NearAiProvider({
      apiKey: "k",
      ledger: new SpendLedger({ apiKey: "k", path: tmp() }),
      fetch: async () => new Response("{}", { status: 404 }),
    });
    expect(await bad.modelPricing("x")).toBeNull();
  });
});

describe("measurement policy provenance", () => {
  it("shipped policy is tofu_provisional_dev", () => {
    expect(loadDefaultPolicy().provenance).toBe("tofu_provisional_dev");
  });
  it("development mode verifies and states the provisional baseline", async () => {
    const f = buildFixture();
    const policy = { ...f.policy, provenance: "tofu_provisional_dev" };
    const v = await verifyNearAiResult(
      cloneResult(f),
      policy,
      { tdxQuote: f.quoteVerifier(), now: () => f.now },
      "development",
    );
    expect(v.verified).toBe(true);
    expect(v.reason).toBe(PROVISIONAL_NOTE);
    expect(() => assertPublishable({ verification: v }, { mode: "development" })).not.toThrow();
    expect(() => assertPublishable({ verification: v }, { mode: "production" })).toThrow(
      NOT_PRODUCTION_APPROVED,
    );
  });
  it("production mode fails closed on a provisional policy (explicit and via NODE_ENV)", async () => {
    const f = buildFixture();
    const policy = { ...f.policy, provenance: "tofu_provisional_dev" };
    const deps = { tdxQuote: f.quoteVerifier(), now: () => f.now };
    const v = await verifyNearAiResult(cloneResult(f), policy, deps, "production");
    expect(v.verified).toBe(false);
    expect(v.reason).toBe(NOT_PRODUCTION_APPROVED);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const v2 = await verifyNearAiResult(cloneResult(f), policy, deps);
      expect(v2.verified).toBe(false);
      expect(v2.reason).toBe(NOT_PRODUCTION_APPROVED);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
  it("a production_approved policy verifies in production", async () => {
    const f = buildFixture();
    const v = await verifyNearAiResult(
      cloneResult(f),
      { ...f.policy, provenance: "production_approved" },
      { tdxQuote: f.quoteVerifier(), now: () => f.now },
      "production",
    );
    expect(v.verified).toBe(true);
    expect(v.reason).toBeUndefined();
  });
});
