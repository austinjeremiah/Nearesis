import { describe, expect, it } from "vitest";
import { hasRefundInfo, refundRows, type RefundSource } from "./refund-causes.ts";
import type { ExplorerTx } from "../adapters/explorer-parse.ts";

const src = (status: string, extra: Partial<ExplorerTx>, key = "a|"): RefundSource => ({
  swap_key: key,
  status,
  created_at: new Date("2026-11-04T13:05:00Z"),
  raw_object_hash: "h".repeat(64),
  version_ms: "1762261500000",
  record: {
    refundTo: "0xabc",
    refundFeeFormatted: "0.1",
    refundType: "ORIGIN_CHAIN",
    ...extra,
  } as ExplorerTx,
});

describe("refund cause rows", () => {
  it("copies the provider's fields verbatim and keeps a missing reason null", () => {
    const rows = refundRows(
      [
        src("REFUNDED", { refundReason: "INTENT_SUBMIT_FAILED", refundFee: "7395007395007396" }, "x|"),
        src("REFUNDED", {}, "y|"),
      ],
      "2026-11-13T00:00:00.000Z",
    );
    expect(rows).toEqual([
      expect.objectContaining({
        swap_key: "x|",
        refund_reason: "INTENT_SUBMIT_FAILED",
        refund_fee_raw: "7395007395007396",
        refund_fee_formatted: "0.1",
        refund_to: "0xabc",
        refund_type: "ORIGIN_CHAIN",
        created_day: "2026-11-04",
        source_label: "LIVE",
        version: 1762261500000,
      }),
      expect.objectContaining({ swap_key: "y|", refund_reason: null, refund_fee_raw: null }),
    ]);
  });
  it("only swaps that are refunded, failed or carry a reason get a row", () => {
    expect(hasRefundInfo(src("SUCCESS", { refundReason: null }))).toBe(false);
    expect(hasRefundInfo(src("SUCCESS", { refundReason: "UNKNOWN" }))).toBe(true);
    expect(hasRefundInfo(src("FAILED", {}))).toBe(true);
    expect(refundRows([src("SUCCESS", {})], "t")).toEqual([]);
  });
});
