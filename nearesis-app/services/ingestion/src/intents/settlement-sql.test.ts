import { describe, expect, it } from "vitest";
import { checkSql } from "../adapters/bigquery-guard.ts";
import { partitionEnd, settlementDrySql, settlementSql, sqlDigest } from "./settlement-sql.ts";

const W = { id: "7d", swapFrom: "2026-10-20", swapTo: "2026-10-26" };
const H = "GnLQcUzbZPZgXQK9wDZDsfwDGCYvDgLy1DBMGgcKKdYJ";

describe("settlement lookup SQL", () => {
  it("reads two columns of one table over a finite partition range with one slack day, and passes the BigQuery guard", () => {
    const sql = settlementSql(W, "proj.scratch.settlement_hashes");
    expect(partitionEnd(W)).toBe("2026-10-28");
    expect(sql).toContain("t.block_date >= DATE '2026-10-20' AND t.block_date < DATE '2026-10-28'");
    expect(sql).toMatch(/SELECT t\.transaction_hash AS tx_hash, t\.block_timestamp AS block_ts_ns/);
    expect(checkSql(sql).ok).toBe(true);
    expect(checkSql(settlementDrySql(W, [H])).ok).toBe(true);
  });
  it("is deterministic (digest) and refuses malformed input", () => {
    expect(sqlDigest(settlementSql(W, "p.s.t"))).toBe(sqlDigest(settlementSql(W, "p.s.t")));
    expect(() => settlementSql({ ...W, swapFrom: "2026-10-27" }, "p.s.t")).toThrow();
    expect(() => settlementSql(W, "p.s.t; DROP TABLE x")).toThrow();
    expect(() => settlementDrySql(W, ["x' OR '1'='1"])).toThrow();
    expect(() => settlementDrySql(W, [])).toThrow();
  });
});
