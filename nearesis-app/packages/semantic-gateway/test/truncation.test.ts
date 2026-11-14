import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResultTruncation } from "@nearesis/contracts";
import { baseline } from "../../../services/analytics/src/index.ts";
import { ast, setupEnv, W1 } from "./helpers.ts";
import type { Env } from "./helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env?.close());

describe("result truncation metadata", () => {
  it("a result cut by the query limit carries explicit truncation metadata; an uncut result carries none", async () => {
    const gw = env.gateway();
    const cut = await gw.query(W1, ast({ limit: 3 }));
    expect(cut.ok, JSON.stringify(cut).slice(0, 300)).toBe(true);
    if (!cut.ok) return;
    expect(cut.envelope.rows).toHaveLength(3);
    const t = ResultTruncation.parse(cut.envelope.truncation);
    expect(t).toMatchObject({
      method: "truncate",
      returnedRows: 3,
      maxRows: 3,
      requestedRowsIsLowerBound: true,
    });
    expect(t.requestedRows).toBeGreaterThan(3);

    const whole = await gw.query(W1, ast({ limit: 1000 }));
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    expect(whole.envelope.truncation).toBeUndefined();
    expect(whole.envelope.rows.length).toBeGreaterThan(3);
  });
});
