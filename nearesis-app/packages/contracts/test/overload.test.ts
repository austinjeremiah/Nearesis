import { describe, expect, it } from "vitest";
import * as C from "../src/index.ts";

const now = "2026-11-12T10:00:00.000Z";

describe("v1.6.0 additions (overload protection and degradation)", () => {
  it("only adds optional fields to older shapes", () => {
    expect(C.CONTRACTS_VERSION).toBe("1.8.0");
    const err = { traceId: "t-1", errorCode: "RATE_LIMITED", message: "slow down", retryable: true };
    expect(C.ErrorResponse.safeParse(err).success).toBe(true);
    expect(C.ErrorResponse.safeParse({ ...err, retryAfterSeconds: 5 }).success).toBe(true);
    expect(C.ErrorResponse.safeParse({ ...err, retryAfterSeconds: 0 }).success).toBe(false);
    const q = {
      question: "Why?",
      snapshotPolicy: "live",
      budget: { tokens: 1000, toolCalls: 1, usd: 0 },
    };
    expect(C.SubmitQuestionRequest.safeParse(q).success).toBe(true);
    expect(C.SubmitQuestionRequest.safeParse({ ...q, priority: "low" }).success).toBe(true);
    // a caller cannot raise its own priority
    expect(C.SubmitQuestionRequest.safeParse({ ...q, priority: "high" }).success).toBe(false);
  });

  it("ResultTruncation is explicit and never says truncated:false", () => {
    const t = {
      truncated: true,
      reason: "MAX_ROWS",
      method: "min_max_bucket",
      requestedRows: 5_000_000,
      returnedRows: 4000,
      maxRows: 10000,
    };
    expect(C.ResultTruncation.safeParse(t).success).toBe(true);
    expect(C.ResultTruncation.safeParse({ ...t, truncated: false }).success).toBe(false);
    expect(C.ResultTruncation.safeParse({ ...t, method: "sample" }).success).toBe(false);
  });

  it("SourceServe and FreshnessWarning validate and reject unknown breaker states", () => {
    const w = {
      code: "SOURCE_DEGRADED",
      message: "Explorer is degraded",
      asOf: now,
      staleSeconds: 600,
      degradedSince: now,
    };
    const s = {
      sourceId: "near-intents-explorer",
      servedFrom: "last_finalized_snapshot",
      asOf: now,
      breaker: "open",
      currentPublicationAllowed: false,
      warning: w,
    };
    expect(C.SourceServe.safeParse(s).success).toBe(true);
    expect(C.SourceServe.safeParse({ ...s, breaker: "ajar" }).success).toBe(false);
    expect(C.OverloadReason.options).toContain("TENANT_QUEUE_FULL");
  });
});
