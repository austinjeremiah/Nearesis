import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertOneClickOutbound,
  base58Decode,
  base58Encode,
  buildQuoteIntel,
  categorize,
  effectiveRate,
  guardOutbound1Click,
  quoteSigningMessage,
  stableStringify,
  usdImpliedCostBps,
  verifyQuoteSignature,
  type QuoteAttemptFacts,
} from "./index.ts";

const kp = generateKeyPairSync("ed25519");
const rawPub = (kp.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
const TEST_KEY = `ed25519:${base58Encode(rawPub)}`;

function signedResponse(over: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    correlationId: "c-1",
    timestamp: "2026-11-12T08:00:48.509Z",
    quoteRequest: {
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: "nep141:eth.omft.near",
      depositType: "ORIGIN_CHAIN",
      destinationAsset: "nep141:base.omft.near",
      amount: "4880096040290072",
      refundTo: "0xabc",
      refundType: "ORIGIN_CHAIN",
      recipient: "0xabc",
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-12T08:10:48.416Z",
      appFees: [{ recipient: "x", fee: 20 }],
    },
    quote: {
      amountIn: "4880096040290072",
      amountInFormatted: "0.004880096040290072",
      amountInUsd: "10.000000000000",
      minAmountIn: "4880096040290072",
      amountOut: "9971278",
      amountOutFormatted: "9.971278",
      amountOutUsd: "9.966172705664",
      minAmountOut: "9871565",
      timeEstimate: 49,
      refundFee: "35",
    },
    ...over,
  };
  const msg = quoteSigningMessage(body);
  body.signature = `ed25519:${base58Encode(sign(null, Buffer.from(msg, "utf8"), kp.privateKey))}`;
  return body;
}

describe("base58 and stable stringify", () => {
  it("round-trips including leading zero bytes", () => {
    const b = Uint8Array.from([0, 0, 1, 2, 255]);
    expect([...base58Decode(base58Encode(b))]).toEqual([...b]);
    expect(base58Encode(Uint8Array.from([0, 0]))).toBe("11");
  });
  it("sorts keys, drops undefined", () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: [1, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[1,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe("signed quote verification (docs.near-intents.org verify-quote-signature + official SDK scheme)", () => {
  it("verifies a correctly signed dry quote", () => {
    expect(verifyQuoteSignature(signedResponse(), TEST_KEY).status).toBe("verified");
  });
  it("rejects a tampered amount as invalid", () => {
    const r = signedResponse() as { quote: Record<string, unknown> };
    r.quote.amountOut = "9999999";
    expect(verifyQuoteSignature(r, TEST_KEY).status).toBe("invalid");
  });
  it("a different key is invalid, not verified", () => {
    const other = generateKeyPairSync("ed25519");
    const k = (other.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
    expect(verifyQuoteSignature(signedResponse(), `ed25519:${base58Encode(k)}`).status).toBe("invalid");
  });
  it("no signature, no timestamp or garbage is signature_unverifiable with a reason", () => {
    const r = signedResponse();
    expect(verifyQuoteSignature({ ...r, signature: undefined }, TEST_KEY)).toMatchObject({
      status: "signature_unverifiable",
    });
    expect(verifyQuoteSignature({ ...r, timestamp: undefined }, TEST_KEY).status).toBe(
      "signature_unverifiable",
    );
    expect(verifyQuoteSignature({ ...r, signature: "ed25519:0OIl" }, TEST_KEY).status).toBe(
      "signature_unverifiable",
    );
    expect(verifyQuoteSignature(null).reason).toMatch(/not an object/);
  });
  it("fields outside the signed set (appFees, correlationId) do not change the message", () => {
    const a = signedResponse();
    const b = { ...a, correlationId: "other", quoteRequest: { ...(a.quoteRequest as object), appFees: [] } };
    expect(verifyQuoteSignature(b, TEST_KEY).status).toBe("verified");
  });
});

const facts = (over: Partial<QuoteAttemptFacts> = {}): QuoteAttemptFacts => ({
  routeId: "ETH.eth>USDC.base",
  originAsset: "nep141:eth.omft.near",
  destinationAsset: "nep141:base.omft.near",
  amountBaseUnits: "4880096040290072",
  privacyMode: "public",
  scheduledBucketUtc: "2026-11-12 08:00:00.000",
  attemptNo: 1,
  slot: "observed",
  class: "OK",
  reason: "ok",
  httpStatus: 201,
  latencyMs: 646,
  fetchedAt: "2026-11-12 08:00:48.416",
  rawObjectHash: "a".repeat(64),
  ...over,
});

describe("quote intelligence", () => {
  it("records every required field for an OK quote with exact rate and indicative label", () => {
    const body = new TextEncoder().encode(JSON.stringify(signedResponse()));
    const i = buildQuoteIntel(facts(), body, {}, TEST_KEY);
    expect(i).toMatchObject({
      availability: "available",
      errorCategory: "none",
      rateLimitStatus: "not_limited",
      inputAmountBaseUnits: "4880096040290072",
      estimatedOutputBaseUnits: "9971278",
      latencyMs: 646,
      quoteKind: "indicative",
      signatureStatus: "verified",
      providerVersion: "1click-openapi-0.1.10",
      timeEstimateS: 49,
    });
    expect(i.quotedEffectiveRate).toBe(effectiveRate("9.971278", "0.004880096040290072"));
    expect(i.quotedEffectiveRate).toMatch(/^\d+\.\d{18}$/);
    expect(i.usdImpliedCostBps).toBe("33.8273");
  });
  it("categorises errors, 429 as rate limited, and never invents values for failures", () => {
    expect(categorize("INVALID_OUTPUT", 429)).toEqual({
      availability: "error",
      errorCategory: "rate_limited",
    });
    expect(categorize("NO_QUOTE", 400).availability).toBe("no_route");
    expect(categorize("TIMEOUT", null).errorCategory).toBe("timeout");
    expect(categorize("NETWORK_ERROR", 503).errorCategory).toBe("provider_5xx");
    expect(categorize(null, null).availability).toBe("not_attempted");
    const i = buildQuoteIntel(facts({ class: "INVALID_OUTPUT", httpStatus: 429 }), null);
    expect(i.rateLimitStatus).toBe("limited");
    expect(i.quotedEffectiveRate).toBeNull();
    expect(i.signatureStatus).toBe("not_applicable");
    const t = buildQuoteIntel(facts({ class: "TIMEOUT", httpStatus: null }), null);
    expect(t.rateLimitStatus).toBe("unknown");
  });
  it("a payload with no signature is signature_unverifiable, not valid", () => {
    const r = signedResponse() as Record<string, unknown>;
    delete r.signature;
    const i = buildQuoteIntel(facts(), new TextEncoder().encode(JSON.stringify(r)), {}, TEST_KEY);
    expect(i.signatureStatus).toBe("signature_unverifiable");
    expect(i.signaturePresent).toBe(false);
  });
  it("rate headers are used when archived", () => {
    const i = buildQuoteIntel(facts({ class: "NO_QUOTE", httpStatus: 400 }), null, {
      "x-ratelimit-remaining": "0",
    });
    expect(i.rateLimitStatus).toBe("limited");
    expect(i.rateLimitRemaining).toBe(0);
  });
  it("exact math helpers never go through floats", () => {
    expect(effectiveRate("1", "3")).toBe("0.333333333333333333");
    expect(effectiveRate("1", "0")).toBeNull();
    expect(usdImpliedCostBps("10", "9.99")).toBe("10.0000");
    expect(usdImpliedCostBps(null, "1")).toBeNull();
  });
});

describe("dry:true at the outbound HTTP boundary", () => {
  const q = "https://1click.chaindefuser.com/v0/quote";
  it("refuses a non-dry or body-less quote before any I/O", async () => {
    let calls = 0;
    const g = guardOutbound1Click(async () => {
      calls++;
      return 1;
    });
    await expect(g({ method: "POST", url: q, body: { dry: false } })).rejects.toThrow();
    await expect(g({ method: "POST", url: q, body: {} })).rejects.toThrow();
    await expect(g({ method: "POST", url: q })).rejects.toThrow();
    await expect(g({ method: "POST", url: q, body: '{"dry":"true"}' })).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(g({ method: "POST", url: q, body: { dry: true } })).resolves.toBe(1);
    await expect(g({ method: "POST", url: q, body: '{"dry":true}' })).resolves.toBe(1);
    expect(calls).toBe(2);
  });
  it("refuses every other 1Click path and leaves other hosts alone", () => {
    for (const p of [
      "/v0/deposit/submit",
      "/v0/generate-intent",
      "/v0/submit-intent",
      "/v0/status",
      "/v0/orders",
    ])
      expect(() =>
        assertOneClickOutbound({
          method: "POST",
          url: `https://1click.chaindefuser.com${p}`,
          body: { dry: true },
        }),
      ).toThrow();
    expect(() =>
      assertOneClickOutbound({ method: "GET", url: "https://1click.chaindefuser.com/v0/tokens" }),
    ).not.toThrow();
    expect(() =>
      assertOneClickOutbound({ method: "GET", url: "https://api.coingecko.com/api/v3/ping" }),
    ).not.toThrow();
  });
});
