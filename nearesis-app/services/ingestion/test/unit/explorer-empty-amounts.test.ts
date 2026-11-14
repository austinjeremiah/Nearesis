import { describe, expect, it } from "vitest";
import { amountOrNull, parseExplorerPage } from "../../src/adapters/explorer-parse.ts";

// Minimal redacted copy of live page 253 item 211 (REFUNDED, provider sent "" for every amount field).
const refunded = {
  originAsset: "1cs_v1:btc:native:coin",
  destinationAsset: "nep141:eth-0xREDACTED.omft.near",
  depositAddress: "bc1qREDACTED",
  depositMemo: null,
  depositAddressAndMemo: "bc1qREDACTED",
  recipient: "0xREDACTED",
  status: "REFUNDED",
  createdAt: "2026-10-29T21:03:53.988Z",
  createdAtTimestamp: 1793307833,
  intentHashes: "REDACTED",
  referral: "swapkit",
  amountInFormatted: "",
  amountOutFormatted: "",
  appFees: [{ recipient: "redacted.near", fee: 145 }],
  nearTxHashes: ["REDACTED"],
  originChainTxHashes: ["REDACTED"],
  destinationChainTxHashes: [],
  amountIn: "",
  amountInUsd: "",
  amountOut: "",
  amountOutUsd: "",
  refundTo: "bc1qREDACTED",
  refundReason: "INTENT_SUBMIT_FAILED",
  refundFee: "3400",
  refundFeeFormatted: "0.000034",
  depositType: "ORIGIN_CHAIN",
  recipientType: "DESTINATION_CHAIN",
  refundType: "ORIGIN_CHAIN",
};
const page = (o: Record<string, unknown>[]): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

describe("explorer empty-string amounts", () => {
  it("accepts the page, maps empty amounts to null and warns missing_amount", () => {
    const ok = {
      ...refunded,
      depositAddress: "bc1qOK",
      amountIn: "100",
      amountOut: "90",
      amountInUsd: "1.0",
      amountOutUsd: "0.9",
    };
    const r = parseExplorerPage(page([ok, refunded]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(2);
    expect(amountOrNull(r.items[1]!.amountIn)).toBeNull();
    expect(amountOrNull(r.items[1]!.amountOut)).toBeNull();
    expect(amountOrNull(r.items[0]!.amountIn)).toBe("100");
    expect(r.warnings).toEqual(["item 1: missing_amount amountIn,amountOut,amountInUsd,amountOutUsd"]);
  });

  it.each(["abc", "1.5", "1e21", "-5", " 1", "0x10"])("still quarantines amountIn=%j", (bad) => {
    const r = parseExplorerPage(page([{ ...refunded, amountIn: bad }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCode).toBe("BAD_SCHEMA");
  });

  it("still quarantines non-string amounts", () => {
    for (const bad of [0, 5, null])
      expect(parseExplorerPage(page([{ ...refunded, amountOut: bad }])).ok).toBe(false);
  });
});
