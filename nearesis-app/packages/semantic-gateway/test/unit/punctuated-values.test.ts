import { describe, expect, it } from "vitest";
import { verifyPunctuatedValues } from "../../src/gateway.ts";

/** A fake ClickHouse client that records the SQL text and bound parameters of every lookup. */
function fakeCh(domain: string[]) {
  const calls: Array<{ query: string; params: { vals: string[] } }> = [];
  const ch = {
    query: async (q: { query: string; query_params: { vals: string[] } }) => {
      calls.push({ query: q.query, params: q.query_params });
      return { json: async () => q.query_params.vals.filter((v) => domain.includes(v)).map((v) => ({ v })) };
    },
  };
  return { ch: ch as never, calls };
}

describe("filter values with punctuation (FND-064)", () => {
  it("passes an existing punctuated value as a bound parameter, never inlined in the SQL text", async () => {
    const { ch, calls } = fakeCh(["Wrapped (NEAR) [v2]", "O'Brien & Sons"]);
    const bad = await verifyPunctuatedValues(ch, [
      { member: "intents.status", values: ["Wrapped (NEAR) [v2]", "O'Brien & Sons"] },
    ]);
    expect(bad).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).not.toMatch(/Wrapped|Brien/);
    expect(calls[0]!.query).toContain("{vals:Array(String)}");
    expect(calls[0]!.params.vals).toEqual(["Wrapped (NEAR) [v2]", "O'Brien & Sons"]);
  });

  it("refuses a punctuated value that is not a stored value of the dimension", async () => {
    const { ch } = fakeCh(["Wrapped (NEAR) [v2]"]);
    const bad = await verifyPunctuatedValues(ch, [
      { member: "intents.status", values: ["x'; DROP TABLE intents_swaps;--"] },
    ]);
    expect(bad).toBe("filters[0].values[0]");
  });

  it("does not look up values that already use the conservative charset", async () => {
    const { ch, calls } = fakeCh([]);
    expect(
      await verifyPunctuatedValues(ch, [{ member: "intents.status", values: ["SUCCESS", "a.b:c/d"] }]),
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
