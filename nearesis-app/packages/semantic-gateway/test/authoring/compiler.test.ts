import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileProposal, bucketStmt, rawAggStmt, normalizeUnit } from "../../src/authoring/index.ts";
import { AGENT, TENANT, setup, txPerDay, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await setup({
    catalogueEdit: (c) => {
      // a tenant-private table owned by somebody else, to prove cross-tenant sources are refused
      const q = c.tables.quote_attempts;
      if (q) q.tenantId = "tenant-other";
    },
  });
});
afterAll(async () => h.close());

const reasons = (input: unknown) => {
  const r = compileProposal(input, h.catalogue, { tenantId: TENANT });
  return r.ok ? [] : r.issues.map((i) => i.reason);
};

describe("source catalogue (generated from the ClickHouse schema)", () => {
  it("contains only authorable tables, hides denied columns and carries declared units", () => {
    const t = h.catalogue.tables;
    expect(Object.keys(t).sort()).toEqual(
      [
        "account_daily_activity",
        "contract_interactions",
        "intents_swaps",
        "near_daily_tx",
        "price_candles",
        "quote_attempts",
      ].sort(),
    );
    expect(t.intents_swaps?.columns.deposit_address).toBeUndefined();
    expect(t.intents_swaps?.denied).toContain("deposit_address");
    expect(t.near_daily_tx?.columns.raw_object_hash).toBeUndefined();
    expect(t.near_daily_tx?.columns.tx_count?.unit).toBe("tx");
    expect(t.near_daily_tx?.dedup).toBe("final");
    expect(t.intents_swaps?.columns.public_swap_tx_hashes).toBeUndefined();
    expect(h.catalogue.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("proposal validation: positives", () => {
  it("compiles a single-table metric and derives its unit", () => {
    const r = compileProposal(txPerDay(), h.catalogue, { tenantId: TENANT });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.derivedUnit).toBe("tx");
  });
  it("compiles a cross-table ratio along a declared join with unit algebra (tx / account)", () => {
    const p = txPerDay(AGENT, {
      name: "tx_per_signer",
      sources: ["near_daily_tx", "account_daily_activity"],
      joins: [
        {
          left: { table: "account_daily_activity", column: "block_date" },
          right: { table: "near_daily_tx", column: "block_date" },
        },
      ],
      aggregations: [
        { id: "tx", fn: "sum", column: { table: "near_daily_tx", column: "tx_count" } },
        { id: "sig", fn: "sum", column: { table: "account_daily_activity", column: "signers_total" } },
      ],
      formula: { kind: "op", op: "div", left: { kind: "agg", id: "tx" }, right: { kind: "agg", id: "sig" } },
      unit: "tx/account",
    });
    const r = compileProposal(p, h.catalogue, { tenantId: TENANT });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.tables.map((t) => t.table)).toEqual(["near_daily_tx", "account_daily_activity"]);
  });
  it("normalizes units", () => {
    expect(normalizeUnit("tx/account")).toBe("tx/account");
    expect(normalizeUnit("USD*tx/tx")).toBe("USD");
    expect(normalizeUnit("1")).toBe("1");
  });
});

describe("proposal validation: negatives", () => {
  it("rejects an unknown field", () => {
    expect(reasons({ ...txPerDay(), colour: "red" })).toContain("UNKNOWN_FIELD");
  });
  it("rejects raw SQL smuggled as a field, as an identifier, or as an expression", () => {
    expect(reasons({ ...txPerDay(), sql: "SELECT 1" })).toContain("RAW_SQL_REFUSED");
    expect(reasons({ ...txPerDay(), where: "1=1" })).toContain("RAW_SQL_REFUSED");
    const inj = txPerDay(AGENT, {
      aggregations: [
        {
          id: "tx",
          fn: "sum",
          column: { table: "near_daily_tx", column: "tx_count) FROM x; DROP TABLE y; --" },
        },
      ],
    });
    expect(reasons(inj)).toContain("RAW_SQL_REFUSED");
    const inj2 = txPerDay(AGENT, {
      filters: [{ column: { table: "near_daily_tx", column: "tx_count" }, op: "gt", values: [0] }],
    });
    expect(
      reasons({ ...inj2, filters: [{ ...inj2.filters[0], expression: "tx_count > (select 1)" }] }),
    ).toContain("RAW_SQL_REFUSED");
  });
  it("filter values are bound parameters, never part of the statement text", () => {
    const p = txPerDay(AGENT, {
      sources: ["intents_swaps"],
      timeGrain: { column: { table: "intents_swaps", column: "created_day" }, grain: "day" },
      aggregations: [{ id: "n", fn: "count", column: null, table: "intents_swaps" }],
      unit: "row",
      filters: [
        {
          column: { table: "intents_swaps", column: "status" },
          op: "eq",
          values: ["x'; DROP TABLE intents_swaps; --"],
        },
      ],
    });
    const r = compileProposal(p, h.catalogue, { tenantId: TENANT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = bucketStmt(r.plan.tables[0]!, "day", false, { from: "2026-09-01", to: "2026-09-02" });
    expect(s.sql).not.toMatch(/DROP|x'/);
    expect(Object.values(s.params)).toContain("x'; DROP TABLE intents_swaps; --");
    expect(
      rawAggStmt(r.plan.tables[0]!, r.plan.tables[0]!.aggs[0]!, false, {
        from: "2026-09-01",
        to: "2026-09-02",
      }).sql,
    ).not.toMatch(/DROP/);
  });
  it("rejects unknown sources and columns, and denied columns", () => {
    expect(reasons(txPerDay(AGENT, { sources: ["secret_table"] }))).toContain("UNKNOWN_SOURCE");
    expect(
      reasons(
        txPerDay(AGENT, {
          aggregations: [{ id: "tx", fn: "sum", column: { table: "near_daily_tx", column: "nope" } }],
        }),
      ),
    ).toContain("UNKNOWN_COLUMN");
    expect(
      reasons(
        txPerDay(AGENT, {
          sources: ["intents_swaps"],
          timeGrain: { column: { table: "intents_swaps", column: "created_day" }, grain: "day" },
          aggregations: [
            { id: "d", fn: "count_distinct", column: { table: "intents_swaps", column: "deposit_address" } },
          ],
          unit: "distinct_deposit_address",
        }),
      ),
    ).toContain("COLUMN_NOT_ALLOWED");
  });
  it("rejects a cross-tenant source and a cross-tenant author", () => {
    const own = txPerDay(AGENT, {
      sources: ["quote_attempts"],
      timeGrain: { column: { table: "quote_attempts", column: "scheduled_bucket_utc" }, grain: "day" },
      aggregations: [{ id: "n", fn: "count", column: null, table: "quote_attempts" }],
      unit: "row",
      dedup: { strategy: "final" },
    });
    expect(reasons(own)).toContain("CROSS_TENANT_SOURCE");
    const other = txPerDay(AGENT);
    other.author.tenantId = "tenant-other";
    expect(reasons(other)).toContain("CROSS_TENANT_SOURCE");
  });
  it("rejects a declared unit that disagrees with the derived unit (S05)", () => {
    expect(reasons(txPerDay(AGENT, { unit: "USD" }))).toContain("UNIT_MISMATCH");
  });
  it("rejects adding unlike units and accepts adding like units", () => {
    const base = txPerDay(AGENT, {
      sources: ["near_daily_tx"],
      aggregations: [
        { id: "tx", fn: "sum", column: { table: "near_daily_tx", column: "tx_count" } },
        { id: "sig", fn: "sum", column: { table: "near_daily_tx", column: "distinct_signer_proxy" } },
      ],
    });
    const bad = {
      ...base,
      formula: {
        kind: "op" as const,
        op: "add" as const,
        left: { kind: "agg" as const, id: "tx" },
        right: { kind: "agg" as const, id: "sig" },
      },
      unit: "tx",
    };
    expect(reasons(bad)).toContain("UNIT_MISMATCH");
    const good = {
      ...base,
      formula: {
        kind: "op" as const,
        op: "mul" as const,
        left: { kind: "agg" as const, id: "tx" },
        right: { kind: "agg" as const, id: "sig" },
      },
      unit: "tx*account",
    };
    expect(reasons(good)).toEqual([]);
  });
  it("refuses to aggregate a column with no declared unit", () => {
    const p = txPerDay(AGENT, {
      sources: ["intents_swaps"],
      timeGrain: { column: { table: "intents_swaps", column: "created_day" }, grain: "day" },
      aggregations: [{ id: "a", fn: "sum", column: { table: "intents_swaps", column: "amount_final" } }],
      unit: "x",
    });
    expect(reasons(p)).toContain("UNIT_UNKNOWN");
  });
  it("refuses an undeclared join, a missing join, an unused source and a missing dedup", () => {
    const two = txPerDay(AGENT, {
      sources: ["near_daily_tx", "account_daily_activity"],
      aggregations: [
        { id: "tx", fn: "sum", column: { table: "near_daily_tx", column: "tx_count" } },
        { id: "sig", fn: "sum", column: { table: "account_daily_activity", column: "signers_total" } },
      ],
      formula: { kind: "op", op: "div", left: { kind: "agg", id: "tx" }, right: { kind: "agg", id: "sig" } },
      unit: "tx/account",
    });
    expect(reasons(two)).toContain("JOIN_NOT_DECLARED");
    const wrongKey = {
      ...two,
      joins: [
        {
          left: { table: "account_daily_activity", column: "tx_total" },
          right: { table: "near_daily_tx", column: "tx_count" },
        },
      ],
    };
    expect(reasons(wrongKey)).toContain("JOIN_NOT_DECLARED");
    expect(reasons(txPerDay(AGENT, { sources: ["near_daily_tx", "price_candles"] }))).toContain(
      "UNUSED_SOURCE",
    );
    expect(reasons(txPerDay(AGENT, { dedup: { strategy: "none_declared_unique" } }))).toContain(
      "DEDUP_REQUIRED",
    );
  });
  it("refuses reserved namespaces and dimension misuse", () => {
    expect(reasons(txPerDay(AGENT, { namespace: "live" }))).toContain("NAMESPACE_RESERVED");
    expect(
      reasons(txPerDay(AGENT, { dimensions: [{ table: "near_daily_tx", column: "tx_count" }] })),
    ).toContain("DIMENSIONS_UNSUPPORTED");
  });
});
