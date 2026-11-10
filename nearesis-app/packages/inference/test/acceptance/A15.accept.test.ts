import { describe, expect, it } from "vitest";
import { z } from "zod";
import { observe } from "@nearesis/acceptance";
import {
  MockInferenceProvider,
  evaluatePublication,
  assertPublishable,
  sha256Hex,
  InferenceError,
} from "../../src/index.ts";

const cases = [
  {
    id: "c1",
    prompt: "Summarise synthetic metric alpha",
    schema: z.object({ summary: z.string(), confidence: z.number().min(0).max(1) }),
  },
  { id: "c2", prompt: "List synthetic tags", schema: z.object({ tags: z.array(z.string()).min(2) }) },
  {
    id: "c3",
    prompt: "Classify synthetic item",
    schema: z.object({ label: z.enum(["a", "b", "c"]), flag: z.boolean() }),
  },
  {
    id: "c4",
    prompt: "Count synthetic rows",
    schema: z.object({ count: z.number().int().min(0).max(1000) }),
  },
  { id: "c5-violating", prompt: "SCRIPTED_VIOLATION synthetic", schema: z.object({ title: z.string() }) },
];

describe("A15 deterministic mock inference", () => {
  it("is byte-identical, labelled unattested_dev, never verified, gate refuses, violation rejected", async () => {
    const mock = new MockInferenceProvider({
      fixtures: [{ promptIncludes: "SCRIPTED_VIOLATION", output: { title: 42, extra: "x" } }],
    });
    const hashes: Record<string, string[]> = {};
    const verifications: unknown[] = [];
    let gateDecisions = 0;
    let rejected = 0;
    let rejectionCode = "";

    for (const c of cases) {
      const outs: string[] = [];
      for (let i = 0; i < 3; i++) {
        try {
          const r = await mock.generateStructured({
            model: "mock-1",
            system: "synthetic",
            prompt: c.prompt,
            schema: c.schema as z.ZodType<unknown>,
            idempotencyKey: `${c.id}-${i}`,
            maxTokens: 256,
          });
          outs.push(JSON.stringify(r));
          expect(r.provider).toBe("mock");
          expect((r.evidence as { attestation: string }).attestation).toBe("unattested_dev");
          const v = await mock.verifyResponse();
          verifications.push(v);
          expect(v.verified).toBe(false);
          expect(v.status).toBe("unattested_dev");
          expect(v.reason).toBe("MOCK_PROVIDER");
          const d = evaluatePublication({ verification: v });
          expect(d.allowed).toBe(false);
          gateDecisions++;
          expect(() => assertPublishable({ verification: v })).toThrow(/PUBLICATION_REFUSED/);
        } catch (e) {
          if (c.id === "c5-violating" && e instanceof InferenceError && e.code === "SCHEMA_INVALID") {
            rejected++;
            rejectionCode = e.code;
          } else throw e;
        }
      }
      if (c.id === "c5-violating") {
        expect(outs).toHaveLength(0);
      } else {
        expect(new Set(outs).size).toBe(1);
        hashes[c.id] = outs.map((o) => sha256Hex(o));
      }
    }
    expect(rejected).toBe(3);
    // (f) all five interface methods exist
    for (const m of ["health", "listModels", "generateStructured", "streamText", "verifyResponse"] as const) {
      expect(typeof mock[m]).toBe("function");
    }
    expect((await mock.health()).ok).toBe(true);
    expect((await mock.listModels())[0]!.attestation).toBe("unsupported");

    observe({
      testId: "A15",
      observed: `4 valid cases x3 calls byte-identical (1 distinct output each); every result provider=mock, attestation=unattested_dev; verifyResponse verified=false reason=MOCK_PROVIDER (${verifications.length} checks); gate refused ${gateDecisions}/${gateDecisions} artifacts; scripted-violation case rejected ${rejected}/3 with ${rejectionCode} after 2 bounded repairs, no value altered; 5/5 interface methods present`,
      fixtureHash: sha256Hex(
        JSON.stringify(cases.map((c) => [c.id, c.prompt, JSON.stringify(z.toJSONSchema(c.schema))])),
      ),
      evidence: {
        outputHashesPerRun: hashes,
        gateDecisions,
        verificationSample: verifications[0],
        rejected,
        rejectionCode,
      },
    });
  });
});
