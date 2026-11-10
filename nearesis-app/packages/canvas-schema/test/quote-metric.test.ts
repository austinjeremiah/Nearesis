import { describe, expect, it } from "vitest";
import type { MetricMetadata } from "@nearesis/contracts";
import { isQuoteMetric } from "../src/panel.ts";

const m = (id: string, sources: string[]) => ({ id, sources }) as unknown as MetricMetadata;

describe("isQuoteMetric", () => {
  it("is true only for quote-attempt datasets and route_quote metrics", () => {
    expect(isQuoteMetric(m("intents.route_quote_availability", ["intents-1click:quote_attempts"]))).toBe(
      true,
    );
    expect(isQuoteMetric(m("intents.route_quote_cost_bps", []))).toBe(true);
  });
  it("treats swap datasets from the same provider as event-time series", () => {
    expect(isQuoteMetric(m("intents.oneclick_completed_swap_count", ["intents-1click:intents_swaps"]))).toBe(
      false,
    );
    expect(isQuoteMetric(m("near.daily_successful_tx_count", ["near-bigquery:near_daily_usage"]))).toBe(
      false,
    );
  });
});
