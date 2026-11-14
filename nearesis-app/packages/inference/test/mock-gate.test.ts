import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MockInferenceProvider,
  assertPublishable,
  createProvider,
  evaluatePublication,
  InferenceError,
} from "../src/index.ts";

const schema = z.object({
  title: z.string(),
  score: z.number().int().min(1).max(5),
  tags: z.array(z.string()),
});
const base = { model: "mock-1", system: "sys", schema, idempotencyKey: "k", maxTokens: 100 };

describe("mock provider", () => {
  it("is byte-deterministic and labelled", async () => {
    const m = new MockInferenceProvider();
    const a = await m.generateStructured({ ...base, prompt: "p1" });
    const b = await m.generateStructured({ ...base, prompt: "p1" });
    const c = await m.generateStructured({ ...base, prompt: "p2" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a.output)).not.toBe(JSON.stringify(c.output));
    expect(a.provider).toBe("mock");
    expect(schema.safeParse(a.output).success).toBe(true);
    expect(await m.verifyResponse()).toEqual({
      verified: false,
      status: "unattested_dev",
      checks: [],
      reason: "MOCK_PROVIDER",
    });
  });
  it("rejects scripted violation after bounded repairs, without altering values", async () => {
    const m = new MockInferenceProvider({ fixtures: [{ promptIncludes: "BAD", output: { title: 5 } }] });
    await expect(m.generateStructured({ ...base, prompt: "BAD case" })).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
  });
  it("createProvider mock + streamText deterministic", async () => {
    const p = createProvider({ mode: "mock" });
    const collect = async () => {
      let s = "";
      for await (const t of p.streamText({ model: "m", system: "s", prompt: "x", maxTokens: 10 })) s += t;
      return s;
    };
    expect(await collect()).toBe(await collect());
  });
});

describe("publication gate", () => {
  it("fails closed", () => {
    expect(() => assertPublishable({ verification: undefined })).toThrow(InferenceError);
    expect(
      evaluatePublication({
        verification: { verified: false, status: "unattested_dev", checks: [], reason: "MOCK_PROVIDER" },
      }).allowed,
    ).toBe(false);
    // a provider-claimed verified status without checks is still refused
    expect(
      evaluatePublication({ verification: { verified: true, status: "verified", checks: [] } }).allowed,
    ).toBe(false);
  });
});
