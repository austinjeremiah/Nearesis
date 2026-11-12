/**
 * Rollup == raw at small, 1M and 10M rows on the LIVE swap model (the model that regressed), in a disposable sandbox
 * (see sandbox.ts). Per size: load deterministic swaps, wait (with a deadline) for the Cube refresh worker to build the rollup,
 * then through the real gateway:
 *   - every day of the rollup-served result equals ClickHouse raw SQL (count, completed, USD known/unknown, exact volume)
 *   - the same query forced onto the RAW path (a filter on a dimension the rollup does not carry) equals the rollup path
 *   - null semantics: the all-unknown-USD day reads NULL volume (not 0) with USD-known = 0
 *   - status and privacy-era filters equal raw per day
 *   - the cost estimate is taken from the rollup (orders of magnitude below the row count)
 * Then, at the small size only, new data lands after the rollup is built and the refresh must converge to the new truth.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cubeLoad, defaultCubeSecret, signCubeToken } from "../../services/analytics/src/index.ts";
import { formatScale } from "../../packages/semantic-gateway/src/index.ts";
import { liveAst, liveGateway, M, rawByDay, session, type LiveGw } from "./lib.ts";
import {
  countRows,
  createSandboxDb,
  dropSandbox,
  genSql,
  loadSwaps,
  sandboxCh,
  SB_DB,
  SB_URL,
  sleep,
  startSandboxCube,
  START_DAY,
  writeCoverage,
} from "./sandbox.ts";
import type { ClickHouseClient } from "../../services/analytics/src/index.ts";

vi.setConfig({ testTimeout: 1_800_000, hookTimeout: 1_800_000 });

const SIZES: Array<{ name: string; rows: number; days: number }> = [
  { name: "small (20k)", rows: 20_000, days: 10 },
  { name: "1M", rows: 1_000_000, days: 30 },
  { name: "10M", rows: 10_000_000, days: 60 },
];
const ctx = session("a16sb-tenant", "a16sb-ws");
const dec = (v: string | number | null) => (v === null ? null : formatScale(String(v), 18));
let ch: ClickHouseClient;
let gw: LiveGw;
/** Same sandbox, cost cap lifted: the raw-path comparison legitimately scans the whole fact table (as PERF10 does for its 10M benchmark). */
let gwRaw: LiveGw;
let nonce = 0;
const endOf = (days: number) =>
  new Date(Date.parse(`${START_DAY}T00:00:00Z`) + days * 86_400_000).toISOString();

beforeAll(async () => {
  await createSandboxDb();
  await startSandboxCube();
  ch = await sandboxCh();
  gw = liveGateway({ cubeUrl: SB_URL, database: SB_DB });
  gwRaw = liveGateway({ cubeUrl: SB_URL, database: SB_DB, policy: { maxEstimatedRows: 1_000_000_000 } });
}, 900_000);
afterAll(async () => {
  await gw?.close();
  await gwRaw?.close();
  await ch?.close();
  await dropSandbox();
});

type Rows = Array<Array<string | number | null>>;
async function untilEquals(
  measures: string[],
  days: number,
  extra: {
    filters?: never[] | Array<{ member: string; operator: string; values: string[] }>;
    dimensions?: string[];
  } = {},
  want: (rows: Rows) => string | null,
  deadlineMs = 900_000,
  via: LiveGw = gw,
): Promise<{ rows: Rows; ms: number; attempts: number; est: number }> {
  const t0 = Date.now();
  let attempts = 0;
  let last = "";
  while (Date.now() - t0 < deadlineMs) {
    attempts++;
    const r = await via.gateway.query(
      ctx,
      liveAst(
        { measures, ...extra, limit: 2_000 + (nonce++ % 7_000) } as never,
        `${START_DAY}T00:00:00Z`,
        endOf(days),
      ),
    );
    if (r.ok) {
      const diff = want(r.envelope.rows as Rows);
      if (!diff)
        return {
          rows: r.envelope.rows as Rows,
          ms: Date.now() - t0,
          attempts,
          est: r.envelope.cost.bytesEstimated / 200,
        };
      last = diff;
    } else last = `${r.error.reasonCode}: ${r.error.message}`;
    await sleep(2_000);
  }
  throw new Error(`not equal to source within ${deadlineMs} ms (${attempts} attempts): ${last}`);
}

const cmpCounts = (raw: Map<string, { swaps: string; completed: string }>, col: 1 | 2) => (rows: Rows) => {
  for (const r of rows) {
    const d = String(r[0]).slice(0, 10);
    const want = col === 1 ? (raw.get(d)?.swaps ?? "0") : (raw.get(d)?.completed ?? "0");
    if (String(r[col]) !== want) return `${d}: got ${r[col]} want ${want}`;
  }
  return null;
};

for (const size of SIZES) {
  describe(`${size.name} rows over ${size.days} days`, () => {
    let raw: Awaited<ReturnType<typeof rawByDay>>;
    const to = (d: number) =>
      new Date(Date.parse(`${START_DAY}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

    beforeAll(async () => {
      const t0 = Date.now();
      await loadSwaps(ch, size.rows, size.days);
      expect(await countRows(ch)).toBe(size.rows);
      raw = await rawByDay(ch, START_DAY, to(size.days));
      console.log(`[${size.name}] loaded ${size.rows} rows in ${Date.now() - t0} ms`);
    });

    it("rollup-served daily count and completed count equal raw SQL, per day and in total", async () => {
      const a = await untilEquals(
        [M.swaps, M.completed],
        size.days,
        {},
        (rows) => cmpCounts(raw, 1)(rows) ?? cmpCounts(raw, 2)(rows),
      );
      const total = a.rows.reduce((s, r) => s + Number(r[1]), 0);
      expect(total).toBe(size.rows);
      expect(a.rows.length).toBe(size.days);
      console.log(
        `[${size.name}] rollup built and served equal-to-source in ${a.ms} ms (${a.attempts} attempts); first-query estimate ${a.est} rows (rollup not built yet: raw rate)`,
      );
      // Once the rollup is built and fresh, a repeat query is priced from it, not from the fact table.
      const b = await untilEquals([M.swaps, M.completed], size.days, {}, cmpCounts(raw, 1));
      console.log(
        `[${size.name}] cost estimate from the built rollup: ${b.est} rows (table holds ${size.rows})`,
      );
      expect(b.est).toBeLessThan(Math.max(size.rows / 100, 1_000));
      expect(gw.gateway.stats().rollupEstimates ?? 0).toBeGreaterThan(0);
    });

    it("USD semantics: known/unknown counts and the exact volume equal raw on every day that has a known USD value", async () => {
      const k = await untilEquals([M.usdKnown, M.usdUnknown], size.days, {}, (rows) => {
        for (const r of rows) {
          const d = String(r[0]).slice(0, 10);
          if (
            String(r[1]) !== (raw.get(d)?.usd_known ?? "0") ||
            String(r[2]) !== (raw.get(d)?.usd_unknown ?? "0")
          )
            return `${d} usd counts`;
        }
        return null;
      });
      expect(k.rows.length).toBe(size.days);
      const v = await untilEquals([M.volume], size.days, {}, (rows) => {
        for (const r of rows) {
          const d = String(r[0]).slice(0, 10);
          if (raw.get(d)?.volume === null) continue; // the all-unknown day is judged in the next test
          if (dec(r[1]) !== dec(raw.get(d)?.volume ?? null))
            return `${d}: got ${r[1]} want ${raw.get(d)?.volume}`;
        }
        return null;
      });
      expect(v.rows.length).toBe(size.days);
    });

    it("null semantics: a day whose swaps ALL have an unknown USD value reads NULL volume, never 0 (Cube returns null; the gateway must keep it)", async () => {
      const nullDay = to(2);
      expect(raw.get(nullDay)!.volume).toBeNull();
      expect(Number(raw.get(nullDay)!.swaps)).toBeGreaterThan(0);
      expect(raw.get(nullDay)!.usd_known).toBe("0");
      // the engine's own answer for that day (rollup path)
      const token = signCubeToken(defaultCubeSecret(), {
        tenantId: "a16sb-tenant",
        workspaceId: "a16sb-ws",
        principalId: "a16",
      });
      const cube = await cubeLoad(SB_URL, token, {
        measures: ["intents_swaps_live.volume_usd_known"],
        timeDimensions: [
          { dimension: "intents_swaps_live.day", granularity: "day", dateRange: [nullDay, nullDay] },
        ],
        timezone: "UTC",
        cache: "must-revalidate",
      });
      expect(cube.data[0]!["intents_swaps_live.volume_usd_known"], "Cube preserves NULL").toBeNull();
      // what the gateway hands to users
      const v = await untilEquals([M.volume], size.days, {}, () => null);
      const row = v.rows.find((r) => String(r[0]).startsWith(nullDay))!;
      expect(row[1], "gateway output for an all-unknown-USD day").toBeNull();
      expect(v.rows.filter((r) => r[1] === null).length).toBe(1);
    });

    it("status and privacy-era filters equal raw per day", async () => {
      for (const f of [
        { member: "intents_swaps_live.status", values: ["FAILED"], where: "status = 'FAILED'" },
        {
          member: "intents_swaps_live.privacy_era",
          values: ["private_settlement"],
          where: "privacy_era = 'private_settlement'",
        },
      ]) {
        const fr = await rawByDay(ch, START_DAY, to(size.days), f.where);
        await untilEquals(
          [M.swaps],
          size.days,
          { filters: [{ member: f.member, operator: "equals", values: f.values }] },
          cmpCounts(fr, 1),
        );
      }
    });

    it("the rollup path equals the raw path (a filter on a dimension the rollup lacks forces the fact-table scan)", async () => {
      const rolled = await untilEquals([M.swaps], size.days, {}, cmpCounts(raw, 1));
      const rawPath = await untilEquals(
        [M.swaps],
        size.days,
        {
          filters: [
            {
              member: "intents_swaps_live.created_at",
              operator: "gte",
              values: [`${START_DAY}T00:00:00.000`],
            },
          ],
        },
        cmpCounts(raw, 1),
        900_000,
        gwRaw,
      );
      expect(rawPath.rows.map((r) => String(r[1]))).toEqual(rolled.rows.map((r) => String(r[1])));
    });
  });
}

describe("refresh after new data lands (small sandbox)", () => {
  it("rows written after the rollup was built are reflected within a bounded time; no result ever exceeds the source", async () => {
    await loadSwaps(ch, 20_000, 10);
    let raw = await rawByDay(ch, START_DAY, endOf(10).slice(0, 10));
    await untilEquals([M.swaps], 10, {}, cmpCounts(raw, 1)); // rollup built on the initial load
    // new data lands: 5,000 more swaps on days 0-9 (new keys, fresh versions), coverage rewritten
    await ch.command({ query: genSql(5_000, 20_000, 10), clickhouse_settings: { max_threads: "2" } });
    await writeCoverage(ch, 10);
    raw = await rawByDay(ch, START_DAY, endOf(10).slice(0, 10));
    const target = Object.values(Object.fromEntries(raw)).reduce((s, r) => s + Number(r.swaps), 0);
    expect(target).toBe(25_000);
    const t0 = Date.now();
    const seen: number[] = [];
    const labelled = new Set<string>();
    let converged = false;
    while (Date.now() - t0 < 300_000) {
      const r = await gw.gateway.query(
        ctx,
        liveAst(
          { measures: [M.swaps], limit: 2_000 + (nonce++ % 7_000) } as never,
          `${START_DAY}T00:00:00Z`,
          endOf(10),
        ),
      );
      if (r.ok) {
        const total = (r.envelope.rows as Rows).reduce((s, x) => s + Number(x[1]), 0);
        seen.push(total);
        labelled.add(`${r.envelope.certification}/${r.cache}`);
        expect(total, "a result may be behind the source but never ahead of it").toBeLessThanOrEqual(25_000);
        if (total === 25_000) {
          converged = true;
          break;
        }
      }
      await sleep(1_000);
    }
    console.log(
      `[refresh] converged=${converged} after ${Date.now() - t0} ms; totals seen: ${[...new Set(seen)].join(" -> ")}; envelope certification/cache during the window: ${[...labelled].join(", ")}`,
    );
    expect(converged).toBe(true);
    // and the per-day figures equal the new raw truth
    await untilEquals([M.swaps], 10, {}, cmpCounts(raw, 1), 60_000);
  });
});
