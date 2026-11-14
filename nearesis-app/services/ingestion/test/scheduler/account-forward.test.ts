import { describe, expect, it } from "vitest";
import { accountChunkOf, pendingAccountDays } from "../../src/scheduler/account-forward.ts";

const now = Date.parse("2026-11-13T09:00:00Z"); // last completed day: 2026-11-12

describe("pendingAccountDays", () => {
  it("lists only days whose transactions chunk is done and whose account chunk is not", () => {
    const done = new Set(["account:2026-11-10"]);
    const days = pendingAccountDays(
      now,
      { isDone: (id) => done.has(id) },
      (d) => d !== "2026-11-12", // provider lag: 11-12 not loaded yet, must not be treated as a gap
    );
    expect(days).toEqual(["2026-11-11"]);
  });
  it("is empty before the forward start", () => {
    expect(
      pendingAccountDays(Date.parse("2026-11-10T09:00:00Z"), { isDone: () => false }, () => true),
    ).toEqual([]);
  });
  it("builds a one-day chunk", () => {
    expect(accountChunkOf("2026-11-10")).toEqual({
      id: "account:2026-11-10",
      from: "2026-11-10",
      to: "2026-11-11",
    });
  });
});
