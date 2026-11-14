import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  baseline,
  duplicatesOf,
  loadNormalized,
  optimizeFinal,
  queryRows,
  canonicalJson,
  sha256,
} from "@nearesis/analytics";
import { ast, settle, setupEnv, W1, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env.close());

const TABLES = [
  "intents_swaps",
  "quote_attempts",
  "price_candles",
  "near_daily_usage",
  "near_signer_days",
  "contract_interactions",
  "source_coverage",
];

async function counts() {
  const out: Record<string, number> = {};
  for (const t of TABLES)
    out[t] = Number(
      (await queryRows<{ n: string }>(env.ch, `SELECT toString(count()) AS n FROM ${t} FINAL`))[0]!.n,
    );
  return out;
}
async function digest() {
  const out: Record<string, string> = {};
  for (const t of TABLES)
    out[t] = (
      await queryRows<{ h: string }>(
        env.ch,
        `SELECT toString(sum(cityHash64(*))) AS h FROM (SELECT * EXCEPT (version) FROM ${t} FINAL ORDER BY 1, 2, 3)`,
      )
    )[0]!.h;
  return out;
}
async function metrics() {
  const gw = env.gateway();
  const q = async (measures: string[]) => {
    const r = await gw.query(W1, ast({ measures }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.envelope.rows;
  };
  return {
    counts: await q([
      "intents.oneclick_total_swap_count",
      "intents.oneclick_completed_swap_count",
      "intents.oneclick_failed_swap_count",
      "intents.oneclick_refunded_swap_count",
    ]),
    volume: await q(["intents.oneclick_volume_usd"]),
  };
}
const dupKeys = async () =>
  (await queryRows(env.ch, `SELECT swap_key FROM intents_swaps FINAL GROUP BY swap_key HAVING count() > 1`))
    .length;

test("S10 duplicate re-delivery leaves facts and metrics unchanged except the declared status update", async () => {
  const base = baseline();
  const dup = duplicatesOf(base, "k3-0"); // day 3, index 0 was SUCCESS, now FAILED at a newer version
  const c0 = await counts();
  const d0 = await digest();
  const m0 = await metrics();

  await loadNormalized(env.ch, dup);
  await settle(env.ch);
  const rawAfterDup = Number(
    (await queryRows<{ n: string }>(env.ch, `SELECT toString(count()) AS n FROM intents_swaps`))[0]!.n,
  );
  const c1 = await counts();
  const d1 = await digest();
  const m1 = await metrics();
  expect(rawAfterDup).toBeGreaterThan(c0.intents_swaps ?? 0); // duplicates physically present before merge
  await optimizeFinal(env.ch, TABLES);
  await settle(env.ch);
  const rawMerged = Number(
    (await queryRows<{ n: string }>(env.ch, `SELECT toString(count()) AS n FROM intents_swaps`))[0]!.n,
  );
  const c2 = await counts();
  const d2 = await digest();
  const m2 = await metrics();

  // (a) per-key counts unchanged, one row per key
  expect(c1).toEqual(c0);
  expect(c2).toEqual(c0);
  expect(await dupKeys()).toBe(0);
  const status = await queryRows<{ status: string; version: string }>(
    env.ch,
    `SELECT status, toString(version) AS version FROM intents_swaps FINAL WHERE swap_key = 'k3-0'`,
  );
  expect(status).toEqual([{ status: "FAILED", version: "1500" }]);
  // (b) metrics: only the declared delta
  const day3 = (rows: (string | number | boolean | null)[][]) =>
    rows.find((r) => String(r[0]).startsWith("2026-10-03"))!;
  const exp = structuredClone(m0.counts);
  const idx = exp.findIndex((r) => String(r[0]).startsWith("2026-10-03"));
  exp[idx]![2] = Number(exp[idx]![2]!) - 1; // completed -1
  exp[idx]![3] = Number(exp[idx]![3]) + 1; // failed +1
  const expectedDelta = {
    day: "2026-10-03",
    completed: -1,
    failed: +1,
    total: 0,
    refunded: 0,
    volumeUsd: "-3.250000000000000000",
  };
  expect(m1.counts).toEqual(exp);
  expect(day3(m0.volume)[1]).toBe("7.500000000000000000"); // 3.25 + 4.25: baseline day-3 SUCCESS swaps
  const vexp = structuredClone(m0.volume);
  vexp[idx]![1] = "4.250000000000000000";
  expect(m1.volume).toEqual(vexp);
  // (c) merge timing independence
  expect(m2).toEqual(m1);
  expect(d2).toEqual(d1);
  // unrelated tables identical to baseline
  for (const t of TABLES.filter((x) => x !== "intents_swaps")) expect(d1[t], t).toBe(d0[t]);
  observe({
    testId: "S10",
    observed: `per-table FINAL counts identical before/after duplicate load and after OPTIMIZE FINAL (intents_swaps=${c0.intents_swaps}); raw rows ${rawAfterDup} before merge vs ${rawMerged} after; 0 duplicate keys; swap k3-0 has exactly 1 row at version 1500 (FAILED); day-3 completed -1, failed +1, volume -3.25; results identical with and without merges`,
    fixtureHash: sha256(canonicalJson({ base: base.digest, dup: dup.digest })),
    evidence: {
      countsBefore: c0,
      countsAfterDup: c1,
      countsAfterMerge: c2,
      rawRows: { afterDupBeforeMerge: rawAfterDup, afterMerge: rawMerged },
      digestsBefore: d0,
      digestsAfterMerge: d2,
      expectedDelta,
      expectedDeltaHash: sha256(canonicalJson(expectedDelta)),
      metricsBefore: m0,
      metricsAfterDup: m1,
      metricsAfterMerge: m2,
    },
  });
});
