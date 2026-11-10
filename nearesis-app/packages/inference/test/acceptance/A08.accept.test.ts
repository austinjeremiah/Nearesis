import { sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  assertPublishable,
  evaluatePublication,
  sha256Hex,
  verifyNearAiResult,
  type NearAiEvidence,
} from "../../src/index.ts";
import { buildFixture, cloneResult, makeSigner } from "../support/near-fixture.ts";

describe("A08 invalid model attestation is fail-closed", () => {
  it("every tampered attestation yields verified=false and the gate refuses; the untampered control is accepted", async () => {
    const f = buildFixture();
    const other = makeSigner();
    type R = ReturnType<typeof cloneResult>;
    const ev = (r: R) => r.evidence as NearAiEvidence;
    const cases: Array<{
      name: string;
      failedCheck: string;
      mutate?: (r: R) => void;
      debug?: boolean;
      now?: number;
    }> = [
      {
        name: "wrong_signer",
        failedCheck: "signer_match",
        mutate: (r) => {
          const s = ev(r).signature!;
          s.signer = { signingAlgo: "ed25519", signingAddress: other.addressHex };
          s.signature = sign(null, Buffer.from(s.signedText), other.privateKey).toString("hex");
        },
      },
      { name: "debug_quote", failedCheck: "tdx_quote_non_debug", debug: true },
      {
        name: "stale_evidence",
        failedCheck: "evidence_fresh",
        mutate: (r) => {
          ev(r).preflight.fetchedAtMs = f.now - 7_200_000;
        },
      },
      {
        name: "response_hash_mismatch",
        failedCheck: "response_binding",
        mutate: (r) => {
          const b = Buffer.from(ev(r).completion.responseBodyB64, "base64");
          b[b.length - 3] = b[b.length - 3]! ^ 1;
          ev(r).completion.responseBodyB64 = b.toString("base64");
        },
      },
      { name: "unaccepted_measurement", failedCheck: "measurement_accepted", mutate: () => {} },
    ];
    const records: unknown[] = [];

    for (const c of cases) {
      const r = cloneResult(f);
      c.mutate?.(r);
      const policy =
        c.name === "unaccepted_measurement"
          ? { ...f.policy, acceptedComposeHashes: ["00".repeat(32)], acceptedOsImageHashes: [] }
          : f.policy;
      const v = await verifyNearAiResult(r, policy, {
        tdxQuote: f.quoteVerifier({ debug: c.debug }),
        now: () => c.now ?? f.now,
      });
      const gate = evaluatePublication({ verification: v });
      expect(v.verified, c.name).toBe(false);
      expect(v.status, c.name).toBe("failed");
      expect(v.checks.find((x) => x.name === c.failedCheck)!.passed, c.name).toBe(false);
      expect(gate.allowed, c.name).toBe(false);
      expect(() => assertPublishable({ verification: v }), c.name).toThrow(/PUBLICATION_REFUSED/);
      records.push({
        case: c.name,
        verified: v.verified,
        status: v.status,
        failedChecks: v.checks.filter((x) => !x.passed).map((x) => x.name),
        gateAllowed: gate.allowed,
      });
    }
    // control: untampered evidence passes all five checks, proving the fixtures are not failing for unrelated reasons
    const control = await verifyNearAiResult(cloneResult(f), f.policy, {
      tdxQuote: f.quoteVerifier(),
      now: () => f.now,
    });
    expect(control.verified).toBe(true);
    expect(control.checks.every((c) => c.passed)).toBe(true);
    expect(() => assertPublishable({ verification: control })).not.toThrow();
    // provider-claimed verification without genuine checks is refused (never derived from a flag)
    expect(
      evaluatePublication({ verification: { verified: true, status: "verified", checks: [] } }).allowed,
    ).toBe(false);

    observe({
      testId: "A08",
      observed: `${cases.length}/${cases.length} tampered attestations (wrong signer, debug quote, stale evidence, response hash mismatch, unaccepted measurement) gave verified=false status=failed with the expected check failing; gate refused all ${cases.length}; untampered control verified=true (5/5 checks) and was publishable; flag-only verified=true without checks refused`,
      fixtureHash: sha256Hex(JSON.stringify(f.evidence)),
      evidence: {
        records,
        control: {
          verified: control.verified,
          checks: control.checks.map((c) => ({ name: c.name, passed: c.passed })),
        },
      },
    });
  });
});
