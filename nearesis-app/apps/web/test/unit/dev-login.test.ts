import { describe, expect, it } from "vitest";
import { devLoginEnabled } from "../../src/lib/server/dev-login.ts";
import { kernelWorkspaceUrl } from "../../src/lib/dev-login.ts";
import { questionBody } from "../../src/lib/run-conversation.ts";
import { MIN_QUESTION_BUDGET, SubmitQuestionRequest } from "@nearesis/contracts";

describe("devLoginEnabled", () => {
  it("needs NEARESIS_DEV_LOGIN=1 and a non-production NODE_ENV", () => {
    expect(devLoginEnabled({ NEARESIS_DEV_LOGIN: "1", NODE_ENV: "development" })).toBe(true);
    expect(devLoginEnabled({ NEARESIS_DEV_LOGIN: "1" })).toBe(true);
    expect(devLoginEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(devLoginEnabled({ NEARESIS_DEV_LOGIN: "0", NODE_ENV: "development" })).toBe(false);
    expect(devLoginEnabled({ NEARESIS_DEV_LOGIN: "1", NODE_ENV: "production" })).toBe(false);
  });
});

describe("kernelWorkspaceUrl", () => {
  const id = "00000000-0000-4000-8000-000000002332";
  it("opens the kernel backend on the semantic layer and keeps the live choice", () => {
    expect(kernelWorkspaceUrl(id)).toBe(`/w/${id}?backend=kernel&data=semantic`);
    expect(kernelWorkspaceUrl(id, "live")).toBe(`/w/${id}?backend=kernel&data=semantic&source=live`);
  });
});

describe("questionBody", () => {
  it("sends the Fixture/Live selection and a budget above the runtime minimum", () => {
    for (const source of ["fixture", "live"] as const) {
      const b = questionBody("why?", source);
      expect(b.source).toBe(source);
      expect(SubmitQuestionRequest.safeParse(b).success).toBe(true);
      expect(b.budget.tokens).toBeGreaterThanOrEqual(MIN_QUESTION_BUDGET.tokens);
      expect(b.budget.toolCalls).toBeGreaterThanOrEqual(MIN_QUESTION_BUDGET.toolCalls);
      expect(b.budget.usd).toBeGreaterThanOrEqual(MIN_QUESTION_BUDGET.usd);
    }
  });
});
