import { describe, expect, it } from "vitest";
import { isAllowed } from "../../src/lib/server/bff-allow.ts";

const ws = "11111111-1111-4111-8111-111111111111";
const run = "22222222-2222-4222-8222-222222222222";

describe("BFF allowlist", () => {
  it("admits the numeric approval id the API issues, and the approvals list", () => {
    expect(isAllowed(`runs/${run}/approvals/6`)).toBe(true);
    expect(isAllowed(`runs/${run}/approvals/123456789012345678`)).toBe(true);
    expect(isAllowed(`runs/${run}/approvals`)).toBe(true);
  });
  it("refuses garbage approval ids and unknown paths", () => {
    expect(isAllowed(`runs/${run}/approvals/abc`)).toBe(false);
    expect(isAllowed(`runs/${run}/approvals/1234567890123456789`)).toBe(false);
    expect(isAllowed(`runs/${run}/approvals/../cancel`)).toBe(false);
    expect(isAllowed(`runs/${run}/approvals/6/extra`)).toBe(false);
    expect(isAllowed(`runs/${run}/secrets`)).toBe(false);
    expect(isAllowed(`admin`)).toBe(false);
  });
  it("admits the routes the shell reads and the run actions", () => {
    for (const p of [
      `workspaces/${ws}/runs`,
      `workspaces/${ws}/sources`,
      `workspaces/${ws}/questions`,
      `runs/${run}`,
      `runs/${run}/cancel`,
    ])
      expect(isAllowed(p)).toBe(true);
  });
});
