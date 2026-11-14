import { describe, expect, it } from "vitest";
import { assertPublishable, verifyNearAiResult, type NearAiEvidence } from "../src/index.ts";
import { buildFixture, cloneResult, makeSigner } from "./support/near-fixture.ts";
import { sign } from "node:crypto";

const failed = (v: Awaited<ReturnType<typeof verifyNearAiResult>>) =>
  v.checks.filter((c) => !c.passed).map((c) => c.name);

async function run(
  f = buildFixture(),
  mutate?: (r: ReturnType<typeof cloneResult>) => void,
  opts?: Parameters<ReturnType<typeof buildFixture>["quoteVerifier"]>[0],
  policy = f.policy,
  now = f.now,
) {
  const r = cloneResult(f);
  mutate?.(r);
  return verifyNearAiResult(r, policy, { tdxQuote: f.quoteVerifier(opts), now: () => now });
}
const ev = (r: { evidence: unknown }) => r.evidence as NearAiEvidence;

describe("NEAR AI verification (synthetic fixtures, injected quote verifier)", () => {
  it("accepts a fully consistent response and gate allows it", async () => {
    const v = await run();
    expect(v.checks.map((c) => c.name)).toHaveLength(5);
    expect(failed(v)).toEqual([]);
    expect(v.verified).toBe(true);
    expect(v.status).toBe("verified");
    expect(() => assertPublishable({ verification: v })).not.toThrow();
  });

  it("debug TDX quote fails tdx_quote_non_debug", async () => {
    const v = await run(undefined, undefined, { debug: true });
    expect(v.verified).toBe(false);
    expect(failed(v)).toContain("tdx_quote_non_debug");
    expect(() => assertPublishable({ verification: v })).toThrow(/PUBLICATION_REFUSED/);
  });

  it("tampered quote (verifier rejects) fails tdx_quote_non_debug", async () => {
    const v = await run(undefined, (r) => {
      ev(r).preflight.attestations[0]!.intelQuote = "tampered-quote";
    });
    expect(failed(v)).toContain("tdx_quote_non_debug");
    expect(v.verified).toBe(false);
  });

  it("TCB status outside policy fails", async () => {
    const v = await run(undefined, undefined, { tcb: "Revoked" });
    expect(v.verified).toBe(false);
  });

  it("unaccepted measurement fails measurement_accepted", async () => {
    const f = buildFixture();
    const v = await run(f, undefined, undefined, { ...f.policy, acceptedComposeHashes: ["00".repeat(32)] });
    expect(failed(v)).toEqual(["measurement_accepted"]);
  });

  it("empty measurement policy fails closed", async () => {
    const f = buildFixture();
    const v = await run(f, undefined, undefined, {
      ...f.policy,
      acceptedComposeHashes: [],
      acceptedOsImageHashes: [],
    });
    expect(failed(v)).toContain("measurement_accepted");
  });

  it("tampered event log fails measurement_accepted (RTMR3 replay)", async () => {
    const v = await run(undefined, (r) => {
      (ev(r).preflight.attestations[0]!.eventLog as Array<{ event_payload: string }>)[0]!.event_payload =
        "ab".repeat(32);
    });
    expect(failed(v)).toContain("measurement_accepted");
  });

  it("wrong signer (valid signature by another key) fails signer_match", async () => {
    const other = makeSigner();
    const v = await run(undefined, (r) => {
      const s = ev(r).signature!;
      s.signer = { signingAlgo: "ed25519", signingAddress: other.addressHex };
      s.signature = sign(null, Buffer.from(s.signedText), other.privateKey).toString("hex");
    });
    expect(failed(v)).toContain("signer_match");
    expect(v.verified).toBe(false);
  });

  it("missing signature fails signer_match and response_binding", async () => {
    const v = await run(undefined, (r) => {
      ev(r).signature = null;
    });
    expect(failed(v)).toEqual(expect.arrayContaining(["signer_match", "response_binding"]));
  });

  it("gateway-kind signature does not count as model binding", async () => {
    const v = await run(undefined, (r) => {
      ev(r).signature!.kind = "gateway";
    });
    expect(failed(v)).toContain("signer_match");
  });

  it("stale evidence fails evidence_fresh", async () => {
    const f = buildFixture();
    const v = await run(f, (r) => {
      ev(r).preflight.fetchedAtMs = f.now - 3_600_000;
    });
    expect(failed(v)).toEqual(["evidence_fresh"]);
  });

  it("verification long after completion fails evidence_fresh", async () => {
    const f = buildFixture();
    const v = await run(f, undefined, undefined, undefined, f.now + 10_000_000);
    expect(failed(v)).toEqual(["evidence_fresh"]);
  });

  it("tampered nonce fails evidence_fresh", async () => {
    const v = await run(undefined, (r) => {
      ev(r).nonce = "11".repeat(32);
      ev(r).preflight.attestations[0]!.nonce = "11".repeat(32);
    });
    expect(failed(v)).toContain("evidence_fresh");
  });

  it("one flipped byte in the response body fails response_binding", async () => {
    const v = await run(undefined, (r) => {
      const b = Buffer.from(ev(r).completion.responseBodyB64, "base64");
      b[b.length - 3] = b[b.length - 3]! ^ 1;
      ev(r).completion.responseBodyB64 = b.toString("base64");
    });
    expect(failed(v)).toContain("response_binding");
    expect(v.verified).toBe(false);
  });

  it("output differing from the signed content fails response_binding", async () => {
    const v = await run(undefined, (r) => {
      (r.output as { answer: string }).answer = "forged";
    });
    expect(failed(v)).toEqual(["response_binding"]);
  });

  it("rawResponseSha256 mismatch fails response_binding", async () => {
    const v = await run(undefined, (r) => {
      r.rawResponseSha256 = "00".repeat(32);
    });
    expect(failed(v)).toEqual(["response_binding"]);
  });

  it("missing or malformed evidence fails every check", async () => {
    const f = buildFixture();
    const r = cloneResult(f);
    r.evidence = { provider: "claimed", verified: true };
    const v = await verifyNearAiResult(r, f.policy, { tdxQuote: f.quoteVerifier(), now: () => f.now });
    expect(v.verified).toBe(false);
    expect(v.checks.every((c) => !c.passed)).toBe(true);
  });
});
