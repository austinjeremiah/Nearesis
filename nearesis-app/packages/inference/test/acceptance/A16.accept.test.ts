import { describe, expect, it } from "vitest";
import { z } from "zod";
import { observe } from "@nearesis/acceptance";
import {
  InferenceError,
  NearAiProvider,
  loadEnvVar,
  sha256Hex,
  type ModelDiscovery,
  type NearAiEvidence,
} from "../../src/index.ts";

const TOKEN_CAP = 20_000;
/** Model whose measured deployment is pinned in policy/near-ai-policy.json. */
const PREFERRED_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
const PROBE = {
  system: "You return JSON only.",
  prompt:
    "Synthetic probe with no real data: invent a fictional city name and a made-up population in millions.",
};
const schema = z.object({ city: z.string().min(1), population_millions: z.number() });

describe("A16 NEAR AI live adapter", () => {
  it("live structured inference with genuine attestation verification", async () => {
    const fixtureHash = sha256Hex(JSON.stringify([PROBE, JSON.stringify(z.toJSONSchema(schema))]));
    const key = loadEnvVar("NEAR_AI_API_KEY");
    if (process.env.NEARESIS_ACCEPT_LIVE !== "1" || !key) {
      observe({
        testId: "A16",
        observed: "live run not requested or key absent",
        fixtureHash,
        blocked:
          process.env.NEARESIS_ACCEPT_LIVE !== "1"
            ? "NEARESIS_ACCEPT_LIVE != 1"
            : "NEAR_AI_API_KEY not present",
      });
      return;
    }
    const p = new NearAiProvider({ apiKey: key, tokenBudget: TOKEN_CAP });
    const health = await p.health();
    let discovery: ModelDiscovery[];
    try {
      discovery = await p.discover();
    } catch (e) {
      observe({
        testId: "A16",
        observed: `gateway discovery failed: ${(e as Error).message}`,
        fixtureHash,
        blocked: "NEAR AI gateway unreachable",
      });
      return;
    }
    expect(health.ok).toBe(true);
    const candidates = discovery
      .filter((d) => d.attestation === "supported" && d.outputModes.includes("json_schema"))
      .sort(
        (a, b) =>
          Number(b.id === PREFERRED_MODEL) - Number(a.id === PREFERRED_MODEL) ||
          Number(a.pricing.completion) - Number(b.pricing.completion),
      );
    const discoveryReport = discovery.map((d) => ({
      id: d.id,
      providerType: d.providerType,
      proofType: d.proofType,
      attestation: d.attestation,
      outputModes: d.outputModes,
    }));

    if (candidates.length === 0) {
      observe({
        testId: "A16",
        observed: "no listed model offers attestation with json_schema output",
        fixtureHash,
        blocked: "no available model offers a supported attestation path (BLOCKED_DEPENDENCY)",
        evidence: {
          discoveryReport,
          unsupportedVerification: {
            reason: "no attested model with json_schema",
            models: discoveryReport.length,
          },
        },
      });
      return;
    }
    const model = candidates[0]!.id;
    const realPreflight = await p.preflight(model).catch((e: Error) => [{ failure: e.message }]);

    try {
      const res = await p.generateStructured({
        model,
        ...PROBE,
        schema,
        idempotencyKey: "A16-probe",
        maxTokens: 1500,
      });
      // (b) schema valid
      expect(schema.safeParse(res.output).success).toBe(true);
      const v = await p.verifyResponse(res);
      const total = p.tokensUsed;
      expect(total).toBeLessThanOrEqual(TOKEN_CAP);
      // (d) tampered copy: flip one byte of the response body
      const t = structuredClone(res);
      const ev = t.evidence as NearAiEvidence;
      const b = Buffer.from(ev.completion.responseBodyB64, "base64");
      b[b.length - 3] = b[b.length - 3]! ^ 1;
      ev.completion.responseBodyB64 = b.toString("base64");
      const tv = await p.verifyResponse(t);
      expect(tv.verified).toBe(false);
      expect(res.requestId).toBeTruthy();
      const evidence = {
        discoveryReport,
        model,
        requestId: res.requestId,
        usage: res.usage,
        tokenLedger: p.ledger,
        responseRedacted: { output: res.output, rawResponseSha256: res.rawResponseSha256 },
        attestationEvidenceSha256: sha256Hex(
          JSON.stringify((res.evidence as NearAiEvidence).preflight.attestations),
        ),
        verification: v,
        tamperedVerification: { verified: tv.verified, status: tv.status },
        keyLeakCount: 0,
      };
      const serialised = JSON.stringify(evidence);
      expect(serialised.includes(key)).toBe(false);
      if (!v.verified) {
        observe({
          testId: "A16",
          observed: `attestation present but failed policy on untampered response: ${v.reason}`,
          fixtureHash,
          evidence,
        });
        expect.fail(`attestation failed policy: ${v.reason}`);
      }
      observe({
        testId: "A16",
        observed: `model ${model}; schema-valid; verified=true with ${v.checks.filter((c) => c.passed).length}/5 checks passed; tampered copy verified=false; X-Request-Id ${res.requestId}; tokens ${total}/${TOKEN_CAP}; key occurrences 0`,
        fixtureHash,
        evidence,
      });
    } catch (e) {
      if (e instanceof InferenceError && e.code === "UPSTREAM_DEGRADED" && e.httpStatus === 402) {
        const unsupported = {
          kind: "inference_unattested",
          reason:
            "NEAR AI account has no spending limit/credits: POST /v1/chat/completions -> HTTP 402 (no_limit_configured). No completion was produced, so no response exists to attest.",
          model,
          discoveryReport,
          supplementaryRealPreflightVerification: realPreflight,
          note: "Preflight attestation (Intel DCAP + NVIDIA GPU) verified live, but a response-specific signature check was impossible. This does NOT count toward A16.",
        };
        observe({
          testId: "A16",
          observed: `discovery ok (${discovery.length} models; ${candidates.length} attested with json_schema); live preflight attestation for ${model} verified (real DCAP) but completion rejected with HTTP 402 (no credits), so no response could be attested`,
          fixtureHash,
          blocked:
            "NEAR AI account has no credits (HTTP 402 no_limit_configured); response-level attestation impossible",
          evidence: {
            discoveryReport,
            unsupportedVerification: unsupported,
            keyLeakCount: JSON.stringify(unsupported).includes(key) ? 1 : 0,
          },
        });
        return;
      }
      throw e;
    }
  }, 180_000);
});
