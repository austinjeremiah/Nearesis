import { describe, expect, it } from "vitest";
import { verifyPunctuatedValues } from "../../src/gateway.ts";

/** A fake ClickHouse client that records every statement it is sent. */
function fakeCh(domain: string[]) {
  const calls: Array<{ query: string; params: unknown }> = [];
  const ch = {
    query: async (q: { query: string; query_params?: unknown }) => {
      calls.push({ query: q.query, params: q.query_params });
      return { json: async () => domain.map((v) => ({ v })) };
    },
  };
  return { ch: ch as never, calls };
}
let clock = 0;
const tick = () => (clock += 60_000); // each test starts past the domain memo TTL

describe("filter values with punctuation (FND-064)", () => {
  it("accepts an existing punctuated value and never sends the caller's text to the database", async () => {
    const { ch, calls } = fakeCh(["Wrapped (NEAR) [v2]", "O'Brien & Sons"]);
    const bad = await verifyPunctuatedValues(
      ch,
      [{ member: "intents.status", values: ["Wrapped (NEAR) [v2]", "O'Brien & Sons"] }],
      tick,
    );
    expect(bad).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).not.toMatch(/Wrapped|Brien/);
    expect(calls[0]!.params).toBeUndefined();
  });

  it("refuses a punctuated value that is not a stored value of the dimension, without querying with it", async () => {
    const { ch, calls } = fakeCh(["Wrapped (NEAR) [v2]"]);
    const bad = await verifyPunctuatedValues(
      ch,
      [{ member: "intents.privacy_era", values: ["x'; DROP TABLE intents_swaps;--"] }],
      tick,
    );
    expect(bad).toBe("filters[0].values[0]");
    expect(JSON.stringify(calls)).not.toMatch(/DROP TABLE/);
  });

  it("does not look up values that already use the conservative charset", async () => {
    const { ch, calls } = fakeCh([]);
    expect(
      await verifyPunctuatedValues(ch, [{ member: "intents.status", values: ["SUCCESS", "a.b:c/d"] }], tick),
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
