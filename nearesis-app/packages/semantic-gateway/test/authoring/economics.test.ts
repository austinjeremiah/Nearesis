import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ECONOMICS_PROPOSALS } from "../../../../services/analytics/src/economics/proposals.ts";
import { ECONOMICS_TABLES } from "../../../../services/ingestion/src/economics/schema.ts";
import { AuthoredMetricStore } from "@nearesis/analytics";
import { buildSourceCatalogue, createAuthoringService } from "../../src/authoring/index.ts";
import { dayOf, principal, setup, type Harness } from "./harness.ts";

/** First real drafts from the queue: A18's five economics proposals, run through the full pipeline on a disposable database. */
let h: Harness;
const A18 = { ...principal("svc-a18-economics", "service", null, "system"), workspaceId: "platform" };
let svc: ReturnType<typeof createAuthoringService>;

beforeAll(async () => {
  h = await setup();
  for (const ddl of ECONOMICS_TABLES) await h.ch.command({ query: ddl });
  const N = 20;
  await h.ins(
    "near_economics_tx_daily",
    Array.from({ length: N }, (_, i) => ({
      block_date: dayOf(i),
      txs: 1000 + i,
      receipts: 3000 + i,
      total_gas: `${(1000 + i) * 2_000_000_000_000}`,
      total_tokens_yocto: `${BigInt(1000 + i) * 123_456_789_012_345_678_901n}`,
      percentile_method: "test",
      token_precision: "source_float64",
      rule_version: 1,
      raw_object_hash: "h",
      fetched_at: `${dayOf(i)} 12:00:00`,
      version: 1,
    })),
  );
  await h.ins(
    "near_economics_gas_price_daily",
    Array.from({ length: N }, (_, i) => ({
      block_date: dayOf(i),
      blocks: 86400,
      sum_gas_price_yocto: `${86400n * 100_000_000n + BigInt(i)}`,
      rule_version: 1,
      raw_object_hash: "h",
      fetched_at: `${dayOf(i)} 12:00:00`,
      version: 1,
    })),
  );
  await h.ins(
    "source_coverage",
    ["near_economics_tx_daily", "near_economics_gas_price_daily"].flatMap((d) =>
      Array.from({ length: N }, (_, i) => ({
        provider_id: "near-bigquery",
        dataset: d,
        day: dayOf(i),
        state: "complete",
        reason: null,
        source_label: "FIXTURE",
        version: 1,
      })),
    ),
  );
  const catalogue = await buildSourceCatalogue(h.ch, { database: h.database });
  svc = createAuthoringService({
    store: new AuthoredMetricStore(h.pool),
    ch: h.ch,
    catalogue: async () => catalogue,
  });
});
afterAll(async () => h.close());

describe("A18 economics proposals through governed authoring", () => {
  it("all five validate (units gas, yoctoNEAR, gas/tx, yoctoNEAR/tx, yoctoNEAR/gas), reconcile against raw, and stay DRAFT-lifecycle until a human certifies", async () => {
    const out: Array<[string, string, string | null]> = [];
    for (const p of ECONOMICS_PROPOSALS) {
      const r = await svc.propose(A18, p);
      expect(r.report?.issues, p.name).toEqual([]);
      expect(r.record.status).toBe("VALIDATED");
      out.push([r.record.metricKey, r.record.status, r.report?.derivedUnit ?? null]);
    }
    expect(out).toEqual([
      ["economics.execution_fee_yocto", "VALIDATED", "yoctoNEAR"],
      ["economics.gas_units", "VALIDATED", "gas"],
      ["economics.gas_per_transaction", "VALIDATED", "gas/tx"],
      ["economics.fee_per_transaction_yocto", "VALIDATED", "yoctoNEAR/tx"],
      ["economics.mean_gas_price_yocto_per_gas", "VALIDATED", "yoctoNEAR/gas"],
    ]);
  });
  it("UInt256 yoctoNEAR sums and gas ratios stay exact (no Float64 cast)", async () => {
    const owner = { ...principal("o", "human", "owner", "system"), workspaceId: "platform" };
    const range = { from: dayOf(0), to: dayOf(2) };
    const fee = await svc.explore(owner, { metricKey: "economics.execution_fee_yocto", version: 1 }, range);
    expect(fee.envelope.rows).toEqual([
      [dayOf(0), "123456789012345678901000"],
      [dayOf(1), "123580245801358024579901"],
    ]);
    expect(fee.envelope.metricStatus).toBe("validated");
    const gpt = await svc.explore(owner, { metricKey: "economics.gas_per_transaction", version: 1 }, range);
    expect(gpt.envelope.rows.map((r) => r[1])).toEqual(["2000000000000.000", "2000000000000.000"]);
    const price = await svc.explore(
      owner,
      { metricKey: "economics.mean_gas_price_yocto_per_gas", version: 1 },
      range,
    );
    expect(price.envelope.rows.map((r) => r[1])).toEqual(["100000000.000", "100000000.000"]);
  });
});
