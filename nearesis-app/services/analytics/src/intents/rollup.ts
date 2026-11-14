/**
 * Verified daily rollup of NEAR Intents swaps (final_master_prompt s15 "precomputed aggregations").
 *
 * The analytics questions an investigator asks most (status per week, refund rates and causes, chain flows, concentration, the
 * summary) all group the deduplicated swaps of a window. Each of them scanned and FINAL-merged the window's raw rows and joined the
 * asset registry (3 to 18 s). `intents_swap_rollup` stores that same `sw` relation (see swapsCte) once per day, grouped by every
 * dimension those analyses use, so the same answers come from a few hundred thousand rows instead of millions.
 *
 * Exactness is by construction and checked on every use:
 *  - a rollup row is produced by `INSERT ... SELECT` from the very same `sw` CTE the raw path uses (same chain resolution, same
 *    asset labels, same FINAL deduplication, same exact Decimal sums); counts and sums over rollup rows are sums of those groups;
 *  - a day is rebuilt as a whole under a new `build_id`; `intents_swap_rollup_days` (ReplacingMergeTree by day) names the build that
 *    is current for the day, so a reader sees the old build or the new one, never a mix, and a swap that changed status leaves no
 *    stale group behind;
 *  - the state row stores a fingerprint of the raw inputs the build read (swaps of the day, refund reasons of the day, the asset
 *    registry). Before a window is served from the rollup the current fingerprints are compared; a day whose fingerprint differs
 *    (new swap, new version of a swap, new refund reason, registry change) is rebuilt first, or the request falls back to the raw
 *    path. The rollup is served only when EVERY day of the window with raw rows matches. Equality tests (rollup.test.ts and
 *    scripts/verify-intents-rollup.ts on the live warehouse) compare the full outputs of the raw and rollup paths.
 *
 * The fingerprint is `cityHash64(max(version), uniqExact(cityHash64(swap_key)))` per day: invariant under ReplacingMergeTree merges,
 * changed by any new swap_key and by any newer version of a key. It cannot see an INSERT of an existing swap_key with a LOWER
 * version (ReplacingMergeTree discards such a row anyway, so the deduplicated relation is unchanged).
 */
import type { ClickHouseClient } from "@clickhouse/client";
import { queryRows } from "../ch.ts";
import { addDays, assertDb, assertWindow, assetLabel, swapsCte } from "./sql.ts";
import type { IntentsWindow } from "./types.ts";

export const ROLLUP_VERSION = "intents-rollup-1";

export interface RollupOptions {
  /** Rebuild stale days on demand (a write to the warehouse). Default true. */
  autoRefresh?: boolean;
  /** Stale days refreshed inline before serving; a bigger gap is served raw while a background build catches up. Default 10. */
  maxInlineDays?: number;
  /** How long one verification of a window stays valid. Default 20 s (the same order as the coverage cache). */
  verifyTtlMs?: number;
  now?: () => number;
}

type Row = Record<string, string>;
const DAY_MS = 86_400_000;

export const rollupTable = (db: string): string => `${assertDb(db)}.intents_swap_rollup`;
export const rollupStateTable = (db: string): string => `${assertDb(db)}.intents_swap_rollup_days`;

/** The rollup as the `rsw` relation of one window (and optionally one privacy era), restricted to the current build of each day. */
export function rollupCte(db: string, era: boolean): string {
  return `WITH rsw AS (
  SELECT * FROM ${rollupTable(db)}
  WHERE day >= {from:Date} AND day <= {to:Date}${era ? " AND era = {era:String}" : ""}
    AND (day, build_id) IN (SELECT day, build_id FROM ${rollupStateTable(db)} FINAL WHERE day >= {from:Date} AND day <= {to:Date})
)`;
}

const DDL = (db: string): string[] => [
  `CREATE TABLE IF NOT EXISTS ${rollupTable(db)}
(
  day Date,
  era LowCardinality(String),
  status LowCardinality(String),
  chain_o LowCardinality(String),
  chain_d LowCardinality(String),
  asset_o String,
  asset_d String,
  mapped_o UInt8,
  mapped_d UInt8,
  refund_reason String,
  n_swaps UInt64,
  v_usd Nullable(Decimal(76, 18)),
  n_unk UInt64,
  n_known UInt64,
  n_usd_null UInt64,
  build_id UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (day, status, chain_o, chain_d, asset_o, asset_d, era, refund_reason, build_id)`,
  `CREATE TABLE IF NOT EXISTS ${rollupStateTable(db)}
(
  day Date,
  /** Version of this state row (a rebuild or a re-stamp); the current row of a day is the one with the highest seq. */
  seq UInt64,
  /** The build whose rollup rows are current for the day. */
  build_id UInt64,
  swaps_fp UInt64,
  refunds_fp UInt64,
  registry_fp UInt64,
  swaps_part UInt64 DEFAULT 0,
  refunds_part UInt64 DEFAULT 0,
  built_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(seq)
ORDER BY day`,
  // tables created by an earlier build of this module
  `ALTER TABLE ${rollupStateTable(db)} ADD COLUMN IF NOT EXISTS swaps_part UInt64 DEFAULT 0`,
  `ALTER TABLE ${rollupStateTable(db)} ADD COLUMN IF NOT EXISTS refunds_part UInt64 DEFAULT 0`,
];

interface Fp {
  /** Per-day fingerprints of the raw rows read; only the days of the months that were checked at day level. */
  swaps: Map<string, string>;
  refunds: Map<string, string>;
  registry: string;
  /** Newest insert block of each month's partition in the swaps / refunds tables (YYYYMM -> block number). */
  partSwaps: Map<string, string>;
  partRefunds: Map<string, string>;
}

const monthOf = (day: string): string => day.slice(0, 7).replace("-", "");
function daysOf(w: IntentsWindow): string[] {
  const out: string[] = [];
  for (let t = Date.parse(w.from); t <= Date.parse(w.to); t += DAY_MS)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export class IntentsRollup {
  readonly db: string;
  private readonly autoRefresh: boolean;
  private readonly maxInline: number;
  private readonly ttl: number;
  private readonly now: () => number;
  private ready: Promise<void> | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private background: Promise<unknown> | null = null;
  private lastBuildId = 0;
  private readonly verified = new Map<string, { at: number; ok: boolean }>();
  /** Counters for the cache-hit-rate report. */
  readonly stats = { served: 0, fellBack: 0, rebuiltDays: 0, verifyMs: 0, verifications: 0 };

  constructor(
    private readonly ch: ClickHouseClient,
    db: string,
    opts: RollupOptions = {},
  ) {
    this.db = assertDb(db);
    this.autoRefresh = opts.autoRefresh ?? true;
    this.maxInline = opts.maxInlineDays ?? 10;
    this.ttl = opts.verifyTtlMs ?? 20_000;
    this.now = opts.now ?? Date.now;
  }

  /** Creates the two tables once per process. */
  ensure(): Promise<void> {
    this.ready ??= (async () => {
      for (const ddl of DDL(this.db)) await this.ch.command({ query: ddl });
    })().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  /** Day-level fingerprints of the given months (YYYYMM) inside the window. */
  private async dayFingerprints(
    w: IntentsWindow,
    months: string[],
  ): Promise<{ swaps: Map<string, string>; refunds: Map<string, string> }> {
    const p = { from: w.from, to: w.to, months };
    const [sw, rf] = await Promise.all([
      queryRows<Row>(
        this.ch,
        `SELECT toString(created_day) AS d, toString(cityHash64(max(version), uniqExact(cityHash64(swap_key)))) AS fp
         FROM ${this.db}.intents_swaps WHERE created_day >= {from:Date} AND created_day <= {to:Date} AND toString(toYYYYMM(created_day)) IN {months:Array(String)} GROUP BY created_day`,
        p,
      ),
      queryRows<Row>(
        this.ch,
        `SELECT toString(created_day) AS d, toString(cityHash64(max(version), uniqExact(cityHash64(swap_key)))) AS fp
         FROM ${this.db}.intents_swap_refunds WHERE created_day >= {from:Date} AND created_day <= {to:Date} AND toString(toYYYYMM(created_day)) IN {months:Array(String)} GROUP BY created_day`,
        p,
      ).catch(() => [] as Row[]), // a warehouse without the refunds side table has no refund reasons: constant fingerprint
    ]);
    return {
      swaps: new Map(sw.map((r) => [r.d as string, r.fp as string])),
      refunds: new Map(rf.map((r) => [r.d as string, r.fp as string])),
    };
  }

  /**
   * Days of the window whose current build is missing or was made from different raw inputs. Cheap path first: the newest insert
   * block of each month's partition (system.parts, no table scan) and the asset registry fingerprint are compared with what each
   * day's state row recorded; a month where all of that is unchanged cannot contain a changed row (the tables are insert-only and a
   * merge never lowers a partition's newest block). Only the other months are fingerprinted per day.
   */
  private async stale(
    w: IntentsWindow,
  ): Promise<{ days: string[]; fp: Fp; restamp: Array<Record<string, unknown>> }> {
    const windowDays = daysOf(w);
    const [parts, regRows, st] = await Promise.all([
      queryRows<Row>(
        this.ch,
        `SELECT \`table\` AS t, partition AS p, toString(max(max_block_number)) AS b FROM system.parts
         WHERE database = {db:String} AND \`table\` IN ('intents_swaps', 'intents_swap_refunds') AND active GROUP BY t, p`,
        { db: this.db },
      ),
      queryRows<Row>(
        this.ch,
        `SELECT toString(cityHash64(max(version), uniqExact(cityHash64(provider_id, provider_asset_id, valid_from, version)))) AS fp FROM ${this.db}.asset_registry`,
      ).catch(() => [] as Row[]),
      queryRows<Row>(
        this.ch,
        `SELECT toString(day) AS d, toString(build_id) AS b, toString(swaps_fp) AS s, toString(refunds_fp) AS r, toString(registry_fp) AS g, toString(swaps_part) AS sp, toString(refunds_part) AS rp
         FROM ${rollupStateTable(this.db)} FINAL WHERE day >= {from:Date} AND day <= {to:Date}`,
        { from: w.from, to: w.to },
      ),
    ]);
    const partSwaps = new Map<string, string>();
    const partRefunds = new Map<string, string>();
    for (const r of parts)
      (r.t === "intents_swaps" ? partSwaps : partRefunds).set(r.p as string, r.b as string);
    const registry = regRows[0]?.fp ?? "0";
    const have = new Map(st.map((r) => [r.d as string, r]));
    const curS = (m: string) => partSwaps.get(m) ?? "0";
    const curR = (m: string) => partRefunds.get(m) ?? "0";
    const dirtyMonths = new Set<string>();
    for (const d of windowDays) {
      const s0 = have.get(d);
      const m = monthOf(d);
      if (!s0 || s0.g !== registry || s0.sp !== curS(m) || s0.rp !== curR(m)) dirtyMonths.add(m);
    }
    const fp: Fp = { swaps: new Map(), refunds: new Map(), registry, partSwaps, partRefunds };
    const days: string[] = [];
    const restamp: Array<Record<string, unknown>> = [];
    if (dirtyMonths.size) {
      const dayFp = await this.dayFingerprints(w, [...dirtyMonths]);
      fp.swaps = dayFp.swaps;
      fp.refunds = dayFp.refunds;
      for (const d of windowDays) {
        if (!dirtyMonths.has(monthOf(d))) continue;
        const s0 = have.get(d);
        const rawS = fp.swaps.get(d) ?? "0";
        const rawR = fp.refunds.get(d) ?? "0";
        // a day without raw rows has a state row with fingerprint 0; it only needs a build when it gained rows
        if (!s0 || s0.s !== rawS || s0.r !== rawR || s0.g !== registry) days.push(d);
        else
          // unchanged day in a month that gained rows elsewhere: stamp it with the current partition state so the month is
          // not re-fingerprinted on every request
          restamp.push({
            day: d,
            build_id: s0.b,
            swaps_fp: s0.s,
            refunds_fp: s0.r,
            registry_fp: registry,
            swaps_part: curS(monthOf(d)),
            refunds_part: curR(monthOf(d)),
          });
      }
    }
    return { days, fp, restamp };
  }

  private nextBuildId(): number {
    this.lastBuildId = Math.max(this.now(), this.lastBuildId + 1);
    return this.lastBuildId;
  }

  /** Rebuilds the given days (contiguous runs in one statement each, at most 31 days per statement). */
  private async build(days: string[], fp: Fp): Promise<void> {
    if (!days.length) return;
    const runs: IntentsWindow[] = [];
    for (const d of days) {
      const last = runs.at(-1);
      if (last && addDays(last.to, 1) === d && Date.parse(d) - Date.parse(last.from) < 31 * DAY_MS)
        last.to = d;
      else runs.push({ from: d, to: d });
    }
    for (const run of runs) {
      const build = this.nextBuildId();
      const lo = assetLabel("o");
      const ld = assetLabel("d");
      await this.ch.command({
        query: `INSERT INTO ${rollupTable(this.db)}
${swapsCte(this.db, false)}, rf AS (SELECT swap_key, refund_reason FROM ${this.db}.intents_swap_refunds FINAL WHERE created_day >= {from:Date} AND created_day <= {to:Date})
SELECT day, era, status, chain_o, chain_d, ${lo} AS asset_o, ${ld} AS asset_d, canon_o IS NOT NULL AS mapped_o, canon_d IS NOT NULL AS mapped_d,
  if(status = 'REFUNDED', multiIf(rf.swap_key = '', 'NOT_LOADED', rf.refund_reason IS NULL, 'NOT_REPORTED', rf.refund_reason), '') AS refund_reason,
  count() AS n_swaps,
  sumIf(usd_in, status = 'SUCCESS' AND usd_in IS NOT NULL) AS v_usd,
  countIf(status = 'SUCCESS' AND usd_in IS NULL) AS n_unk,
  countIf(status = 'SUCCESS' AND usd_in IS NOT NULL) AS n_known,
  countIf(usd_in IS NULL) AS n_usd_null,
  toUInt64({build:UInt64}) AS build_id
FROM sw LEFT JOIN rf ON rf.swap_key = sw.swap_key
GROUP BY day, era, status, chain_o, chain_d, asset_o, asset_d, mapped_o, mapped_d, refund_reason`,
        query_params: { from: run.from, to: run.to, build },
      });
      const rows: Array<Record<string, unknown>> = [];
      for (const d of daysOf(run))
        rows.push({
          day: d,
          seq: build,
          build_id: build,
          swaps_fp: fp.swaps.get(d) ?? "0",
          refunds_fp: fp.refunds.get(d) ?? "0",
          registry_fp: fp.registry,
          swaps_part: fp.partSwaps.get(monthOf(d)) ?? "0",
          refunds_part: fp.partRefunds.get(monthOf(d)) ?? "0",
        });
      // the state row is written last: until then readers keep the previous build of these days
      await this.ch.insert({ table: rollupStateTable(this.db), values: rows, format: "JSONEachRow" });
      this.stats.rebuiltDays += rows.length;
      await this.ch
        .command({
          query: `ALTER TABLE ${rollupTable(this.db)} DELETE WHERE day >= {from:Date} AND day <= {to:Date} AND build_id < {build:UInt64}`,
          query_params: { from: run.from, to: run.to, build },
        })
        .catch(() => undefined); // best effort: superseded builds are invisible to readers either way
    }
  }

  private async stamp(rows: Array<Record<string, unknown>>): Promise<void> {
    if (!rows.length) return;
    const seq = this.nextBuildId();
    await this.ch.insert({
      table: rollupStateTable(this.db),
      values: rows.map((r) => ({ ...r, seq })),
      format: "JSONEachRow",
    });
  }

  /** Rebuilds every stale day of a window now (used by the pre-warm and the loader CLI). Returns the number of days rebuilt. */
  async refresh(w: IntentsWindow): Promise<number> {
    assertWindow(w);
    await this.ensure();
    const run = async (): Promise<number> => {
      const { days, fp, restamp } = await this.stale(w);
      await this.build(days, fp);
      await this.stamp(restamp);
      this.verified.delete(`${w.from}|${w.to}`);
      return days.length;
    };
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => undefined);
    return p;
  }

  /**
   * True when the whole window can be served from the rollup right now: every day with raw rows has a current build whose
   * fingerprints equal the raw inputs'. Stale days are rebuilt inline when few; otherwise the caller gets false (raw path) and a
   * background build catches the rollup up. Never throws: any failure means "use the raw path".
   */
  async covers(w: IntentsWindow): Promise<boolean> {
    try {
      assertWindow(w);
      const key = `${w.from}|${w.to}`;
      const hit = this.verified.get(key);
      if (hit && this.now() - hit.at < this.ttl) {
        if (hit.ok) this.stats.served++;
        else this.stats.fellBack++;
        return hit.ok;
      }
      const t0 = Date.now();
      await this.ensure();
      let { days, fp, restamp } = await this.stale(w);
      let ok = days.length === 0;
      if (restamp.length) await this.stamp(restamp).catch(() => undefined);
      if (!ok && this.autoRefresh && days.length <= this.maxInline) {
        const run = async () => {
          ({ days, fp, restamp } = await this.stale(w)); // another caller may have rebuilt them while this one waited
          await this.build(days, fp);
          await this.stamp(restamp);
        };
        const p = this.lock.then(run, run);
        this.lock = p.catch(() => undefined);
        await p;
        ok = true;
      } else if (!ok && this.autoRefresh && !this.background) {
        this.background = this.refresh(w)
          .catch(() => undefined)
          .finally(() => {
            this.background = null;
          });
      }
      this.stats.verifications++;
      this.stats.verifyMs += Date.now() - t0;
      this.verified.set(key, { at: this.now(), ok });
      if (ok) this.stats.served++;
      else this.stats.fellBack++;
      return ok;
    } catch {
      this.stats.fellBack++;
      return false;
    }
  }
}
