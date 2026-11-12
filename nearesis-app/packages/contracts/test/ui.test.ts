import { describe, expect, it } from "vitest";
import * as C from "../src/index.ts";

const uuid = "11111111-1111-4111-8111-111111111111";
const now = "2026-11-10T12:00:00.000Z";

describe("v1.3.0 additions (ui read models)", () => {
  it("is additive (the 1.3.0 shapes are unchanged in 1.6.0)", () => {
    expect(C.CONTRACTS_VERSION).toBe("1.7.0");
    expect(C.CommandType.safeParse("canvas.apply_patch").success).toBe(true);
  });
  it("RunListResponse accepts a run row and rejects unknown states and extra keys", () => {
    const row = {
      runId: uuid,
      questionSummary: "Why did fees spike?",
      state: "EXECUTING",
      terminal: false,
      startedAt: now,
      updatedAt: now,
    };
    expect(C.RunListResponse.safeParse({ workspaceId: uuid, runs: [row] }).success).toBe(true);
    expect(
      C.RunListResponse.safeParse({ workspaceId: uuid, runs: [{ ...row, state: "DONE" }] }).success,
    ).toBe(false);
    expect(C.RunListResponse.safeParse({ workspaceId: uuid, runs: [{ ...row, secret: 1 }] }).success).toBe(
      false,
    );
  });
  it("SourceListResponse allows an empty list and validates freshness", () => {
    expect(C.SourceListResponse.safeParse({ workspaceId: uuid, sources: [] }).success).toBe(true);
    const s = { sourceId: "near-intents", name: "NEAR Intents", freshness: "late", watermark: null };
    expect(C.SourceListResponse.safeParse({ workspaceId: uuid, sources: [s] }).success).toBe(true);
    expect(
      C.SourceListResponse.safeParse({ workspaceId: uuid, sources: [{ ...s, freshness: "ok" }] }).success,
    ).toBe(false);
  });
  it("RunBudgetUsage needs total, spent and reserved amounts", () => {
    const a = { tokens: 1, toolCalls: 2, usd: 0.5 };
    expect(C.RunBudgetUsage.safeParse({ total: a, spent: a, reserved: a }).success).toBe(true);
    expect(C.RunBudgetUsage.safeParse({ total: a, spent: a }).success).toBe(false);
    expect(C.RunBudgetUsage.safeParse({ total: a, spent: { ...a, usd: -1 }, reserved: a }).success).toBe(
      false,
    );
  });
});

describe("v1.4.0 additions (question source)", () => {
  const base = {
    question: "why",
    snapshotPolicy: "pinned",
    budget: { tokens: 200000, toolCalls: 24, usd: 10 },
  };
  it("defaults source to fixture and accepts live", () => {
    expect(C.SubmitQuestionRequest.parse(base).source).toBe("fixture");
    expect(C.SubmitQuestionRequest.parse({ ...base, source: "live" }).source).toBe("live");
  });
  it("rejects an unknown source and still rejects extra keys", () => {
    expect(C.SubmitQuestionRequest.safeParse({ ...base, source: "prod" }).success).toBe(false);
    expect(C.SubmitQuestionRequest.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});
