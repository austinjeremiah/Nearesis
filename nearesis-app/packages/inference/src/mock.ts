import { z } from "zod";
import type { InferenceProvider, StructuredResult, VerificationResult } from "@nearesis/contracts";
import { sha256Hex } from "./hash.ts";
import { validateWithRepair } from "./structured.ts";

export interface MockFixture {
  /** Applies when the prompt contains this text. First match wins. */
  promptIncludes: string;
  /** Raw JSON-serialisable output returned verbatim (may deliberately violate the schema). */
  output: unknown;
}

type Json = Record<string, unknown>;

/** Deterministic value generator driven by a seed hash and a JSON Schema. */
function gen(schema: Json, seed: string, path: string): unknown {
  const h = sha256Hex(`${seed}|${path}`);
  const n = parseInt(h.slice(0, 8), 16);
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[n % schema.enum.length];
  for (const key of ["anyOf", "oneOf"] as const) {
    const alts = schema[key];
    if (Array.isArray(alts) && alts.length > 0) return gen(alts[0] as Json, seed, path);
  }
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (t) {
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, Json>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(props).sort()) out[k] = gen(props[k]!, seed, `${path}.${k}`);
      return out;
    }
    case "array": {
      const min = typeof schema.minItems === "number" ? schema.minItems : 1;
      const len = Math.max(min, 1);
      return Array.from({ length: len }, (_, i) => gen((schema.items ?? {}) as Json, seed, `${path}[${i}]`));
    }
    case "string": {
      const min = typeof schema.minLength === "number" ? schema.minLength : 0;
      let s = `mock-${h.slice(0, 8)}`;
      while (s.length < min) s += h;
      return typeof schema.maxLength === "number" ? s.slice(0, schema.maxLength) : s;
    }
    case "integer":
    case "number": {
      const lo = typeof schema.minimum === "number" ? schema.minimum : 0;
      const hi = typeof schema.maximum === "number" ? schema.maximum : lo + 100;
      const v = lo + (n % (Math.floor(hi - lo) + 1));
      return v;
    }
    case "boolean":
      return n % 2 === 0;
    case "null":
      return null;
    default:
      return `mock-${h.slice(0, 8)}`;
  }
}

export class MockInferenceProvider implements InferenceProvider {
  readonly id = "mock";
  private readonly fixtures: MockFixture[];

  constructor(opts: { fixtures?: MockFixture[] } = {}) {
    this.fixtures = opts.fixtures ?? [];
  }

  async health() {
    return { ok: true, detail: "mock provider (unattested_dev)" };
  }

  async listModels() {
    return [{ id: "mock-1", attestation: "unsupported" as const, outputModes: ["json_schema", "text"] }];
  }

  async generateStructured<T>(args: {
    model: string;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    idempotencyKey: string;
    maxTokens: number;
  }): Promise<StructuredResult<T>> {
    const jsonSchema = z.toJSONSchema(args.schema) as Json;
    const schemaJson = JSON.stringify(jsonSchema);
    const { output, attempt, attempts } = await validateWithRepair(
      args.schema,
      args.prompt,
      async (prompt) => {
        const fixture = this.fixtures.find((f) => prompt.includes(f.promptIncludes));
        const seed = sha256Hex(JSON.stringify([args.model, args.system, prompt, schemaJson]));
        const value = fixture ? fixture.output : gen(jsonSchema, seed, "$");
        return { text: JSON.stringify(value), meta: { seed } };
      },
    );
    const inputChars = args.system.length + args.prompt.length;
    const requestHash = sha256Hex(JSON.stringify([args.model, args.system, args.prompt, schemaJson]));
    return {
      output,
      provider: "mock",
      model: args.model,
      requestId: `mock-${requestHash.slice(0, 16)}`,
      usage: {
        inputTokens: Math.ceil(inputChars / 4),
        outputTokens: Math.min(args.maxTokens, Math.ceil(attempt.text.length / 4)),
      },
      evidence: { kind: "mock", attestation: "unattested_dev", attempts },
      rawResponseSha256: sha256Hex(attempt.text),
    };
  }

  async *streamText(args: {
    model: string;
    system: string;
    prompt: string;
    maxTokens: number;
  }): AsyncIterable<string> {
    const h = sha256Hex(JSON.stringify([args.model, args.system, args.prompt]));
    const words = Array.from({ length: 4 }, (_, i) => `mock-${h.slice(i * 6, i * 6 + 6)}`);
    for (const w of words) yield `${w} `;
  }

  async verifyResponse(): Promise<VerificationResult> {
    return { verified: false, status: "unattested_dev", checks: [], reason: "MOCK_PROVIDER" };
  }
}
