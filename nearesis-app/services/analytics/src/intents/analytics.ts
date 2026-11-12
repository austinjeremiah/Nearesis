import type { ClickHouseClient } from "@clickhouse/client";
import { queryRows } from "../ch.ts";
import { cmp, format, norm, pctChange, ratio, sub, sum } from "./dec.ts";
import { FIELD_INVENTORY, SOURCES } from "./inventory.ts";
import {
  addDays,
  assertDb,
  assertWindow,
  assetLabel,
  daysBetween,
  swapsCte,
  TERMINAL,
  UNK,
  VOL,
} from "./sql.ts";
import { UNUSUAL_METHOD, concentration, detectUnusual, type UnusualOpts } from "./stats.ts";
import {
  INTENTS_METRICS_VERSION,
  type IntentsCannotCompute,
  type IntentsChartHint,
  type IntentsCoverage,
  type IntentsDayCoverage,
  type IntentsOk,
  type IntentsProvenance,
  type IntentsResult,
  type IntentsWindow,
} from "./types.ts";

export interface IntentsOptions {
  database?: string;
  now?: () => Date;
}

type Row = Record<string, string>;
const n = (v: string | undefined): number => Number(v ?? "0");
const dec = (v: string | null | undefined): string | null => (v === null || v === undefined ? null : norm(v));

const SCOPE_NOTE =
  "Explorer API 1Click transaction history only. It is not every NEAR Intents interaction (no direct solver-to-verifier intents, no non-1Click flows).";
const PRIVATE_NOTE =
  "From the private-settlement transition on, swaps with privacy_era = private_settlement are visible only as Explorer rows; on-chain observability of them is incomplete.";

export const SIZE_BUCKETS = [
  { label: "<10", lo: 0, hi: 10 },
  { label: "10-100", lo: 10, hi: 100 },
  { label: "100-1k", lo: 100, hi: 1_000 },
  { label: "1k-10k", lo: 1_000, hi: 10_000 },
  { label: "10k-100k", lo: 10_000, hi: 100_000 },
  { label: ">=100k", lo: 100_000, hi: null },
] as const;

const bucketExpr = `multiIf(usd_in IS NULL, 'unknown_usd',
  usd_in < 10, '<10', usd_in < 100, '10-100', usd_in < 1000, '100-1k', usd_in < 10000, '1k-10k', usd_in < 100000, '10k-100k', '>=100k')`;

export class IntentsAnalytics {
  readonly db: string;
  private readonly now: () => Date;
  constructor(
    private readonly ch: ClickHouseClient,
    opts: IntentsOptions = {},
  ) {
    this.db = assertDb(opts.database ?? "nearesis_live");
    this.now = opts.now ?? (() => new Date());
  }

  private params(
    w: IntentsWindow,
    era?: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { from: w.from, to: w.to, ...(era ? { era } : {}), ...extra };
  }

  /** The last `days` days ending at the newest day marked complete in source coverage (null when no day is complete yet). */
  async defaultWindow(days = 30): Promise<IntentsWindow | null> {
    const [r] = await queryRows<Row>(
      this.ch,
      `SELECT toString(maxIf(day, st = 'complete')) AS d FROM (SELECT day, argMax(state, version) AS st FROM ${this.db}.source_coverage WHERE provider_id = 'near-explorer' AND dataset = 'intents_swaps' GROUP BY day)`,
    );
    const d = r?.d;
    if (!d || d.startsWith("1970")) return null;
    return { from: addDays(d, -days + 1), to: d };
  }

  // ---------- coverage and provenance ----------

  private readonly covCache = new Map<string, { at: number; v: IntentsCoverage }>();

  /** Coverage of a window; cached for 30 s per (window, era) so one API request does not re-scan the same rows. */
  async coverage(w: IntentsWindow, era?: string): Promise<IntentsCoverage> {
    assertWindow(w);
    const key = `${w.from}|${w.to}|${era ?? ""}`;
    const hit = this.covCache.get(key);
    if (hit && this.now().getTime() - hit.at < 30_000) return hit.v;
    const v = await this.coverageUncached(w, era);
    this.covCache.set(key, { at: this.now().getTime(), v });
    return v;
  }

  private async coverageUncached(w: IntentsWindow, era?: string): Promise<IntentsCoverage> {
    const cov = await queryRows<Row>(
      this.ch,
      `SELECT toString(day) AS d, argMax(state, version) AS state, argMax(reason, version) AS reason
       FROM ${this.db}.source_coverage WHERE provider_id = 'near-explorer' AND dataset = 'intents_swaps' AND day >= {from:Date} AND day <= {to:Date} GROUP BY day ORDER BY day`,
      { from: w.from, to: w.to },
    );
    const eras = await queryRows<Row>(
      this.ch,
      `SELECT privacy_era AS era, count() AS c, countIf(amount_in_usd IS NULL) AS usd_unknown FROM ${this.db}.intents_swaps FINAL WHERE created_day >= {from:Date} AND created_day <= {to:Date} GROUP BY era`,
      { from: w.from, to: w.to },
    );
    const sel = era ? eras.filter((r) => r.era === era) : eras;
    const agg = {
      rows: String(sel.reduce((a, r) => a + n(r.c), 0)),
      usd_unknown: String(sel.reduce((a, r) => a + n(r.usd_unknown), 0)),
    };
    const have = new Map(cov.map((r) => [r.d as string, r]));
    const total = daysBetween(w.from, w.to);
    const incomplete: IntentsDayCoverage[] = [];
    const missing: string[] = [];
    let complete = 0;
    for (let i = 0; i < total; i++) {
      const d = addDays(w.from, i);
      const r = have.get(d);
      if (!r) missing.push(d);
      else if (r.state === "complete") complete++;
      else
        incomplete.push({
          day: d,
          state: r.state ?? "unknown",
          reason: r.reason && r.reason !== "\\N" ? r.reason : null,
        });
    }
    const rows = n(agg.rows);
    const unk = n(agg.usd_unknown);
    return {
      dataset: "intents_swaps",
      source: "NEAR Intents Explorer API (1Click transactions)",
      scopeNote: SCOPE_NOTE,
      window: w,
      daysInWindow: total,
      completeDays: complete,
      incompleteDays: incomplete,
      missingDays: missing,
      swapRows: rows,
      usdUnknownRows: unk,
      usdKnownShare: ratio(rows - unk, rows),
      eraSplit: Object.fromEntries(eras.map((r) => [r.era as string, n(r.c)])),
      privateSettlementNote: PRIVATE_NOTE,
    };
  }

  private async prov(tables: string[], method: string): Promise<IntentsProvenance> {
    const [wm] = await queryRows<Row>(
      this.ch,
      `SELECT toString(argMax(newest_event_time, version)) AS t FROM ${this.db}.source_watermarks WHERE provider_id = 'near-explorer'`,
    ).catch(() => [] as Row[]);
    return {
      source: "nearesis_live (ingested from the NEAR Intents Explorer API and the 1Click token list)",
      tables: tables.map((t) => `${this.db}.${t}`),
      asOf: wm?.t ?? null,
      computedAt: this.now().toISOString(),
      metricVersion: INTENTS_METRICS_VERSION,
      method,
    };
  }

  private async ok<T>(
    metric: string,
    definition: string,
    w: IntentsWindow | null,
    chart: IntentsChartHint,
    data: T,
    tables: string[],
    method: string,
    caveats: string[] = [],
    era?: string,
  ): Promise<IntentsOk<T>> {
    return {
      status: "OK",
      metric,
      definition,
      window: w,
      chart,
      data,
      coverage: w ? await this.coverage(w, era) : null,
      provenance: await this.prov(tables, method),
      caveats,
    };
  }

  private async cannot(
    metric: string,
    missing: string[],
    explanation: string,
    evidence: string[],
    alternative?: IntentsCannotCompute["alternative"],
    w?: IntentsWindow,
  ): Promise<IntentsCannotCompute> {
    return {
      status: "CANNOT_COMPUTE",
      metric,
      missing,
      explanation,
      evidence,
      ...(alternative ? { alternative } : {}),
      coverage: w ? await this.coverage(w) : null,
      provenance: await this.prov(["intents_swaps"], "capability analysis of the source schema"),
    };
  }

  // ---------- swaps ----------

  async summary(w: IntentsWindow, era?: string): Promise<IntentsResult<Record<string, unknown>>> {
    assertWindow(w);
    const [r] = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, !!era)} SELECT count() AS swaps, countIf(status='SUCCESS') AS success, countIf(status='REFUNDED') AS refunded, countIf(status='FAILED') AS failed,
         countIf(status NOT IN ('SUCCESS','REFUNDED','FAILED')) AS in_flight, ${VOL} AS vol, ${UNK} AS unk,
         countIf(chain_o = 'unknown' OR chain_d = 'unknown') AS chain_unknown, countIf(canon_o IS NULL OR canon_d IS NULL) AS asset_unmapped FROM sw`,
      this.params(w, era),
    );
    const terminal = n(r?.success) + n(r?.refunded) + n(r?.failed);
    return this.ok(
      "intents.summary",
      "Swap count and settled USD volume. Volume = sum of provider amountInUsd over SUCCESS swaps that have one; swaps without a USD value are counted separately and excluded, never valued at 0.",
      w,
      { kind: "table" },
      {
        swaps: n(r?.swaps),
        success: n(r?.success),
        refunded: n(r?.refunded),
        failed: n(r?.failed),
        inFlight: n(r?.in_flight),
        successRate: ratio(n(r?.success), terminal),
        refundRate: ratio(n(r?.refunded), terminal),
        failedRate: ratio(n(r?.failed), terminal),
        settledVolumeUsdKnown: dec(r?.vol),
        settledSwapsWithUnknownUsd: n(r?.unk),
        swapsWithUnresolvedChain: n(r?.chain_unknown),
        swapsWithUnmappedAsset: n(r?.asset_unmapped),
      },
      ["intents_swaps", "asset_registry"],
      "FINAL-deduplicated rows grouped in ClickHouse; rates are exact decimal ratios over terminal swaps (SUCCESS+REFUNDED+FAILED).",
      [],
      era,
    );
  }

  async statusDistribution(
    w: IntentsWindow,
    by: "none" | "day" = "none",
  ): Promise<IntentsResult<Array<Record<string, unknown>>>> {
    assertWindow(w);
    const rows = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT ${by === "day" ? "toString(day) AS dstr," : ""} status, count() AS swaps, ${VOL} AS vol, ${UNK} AS unk FROM sw GROUP BY ${by === "day" ? "dstr, " : ""}status ORDER BY ${by === "day" ? "dstr, " : ""}swaps DESC`,
      this.params(w),
    );
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.dstr ?? "", (totals.get(r.dstr ?? "") ?? 0) + n(r.swaps));
    const data = rows.map((r) => ({
      ...(by === "day" ? { day: r.dstr } : {}),
      status: r.status,
      swaps: n(r.swaps),
      share: ratio(n(r.swaps), totals.get(r.dstr ?? "") ?? 0),
      volumeUsdKnown: dec(r.vol),
      swapsWithUnknownUsd: n(r.unk),
    }));
    return this.ok(
      "intents.status_distribution",
      "Swaps per Explorer status; share is of all swaps in the group (day or window).",
      w,
      by === "day"
        ? { kind: "stacked_bar", x: "day", y: "swaps", series: "status" }
        : { kind: "bar", x: "status", y: "swaps" },
      data,
      ["intents_swaps"],
      "count and Decimal sum per status",
      [
        "Volume shown for non-SUCCESS statuses is the provider's amountInUsd and may be absent for REFUNDED swaps.",
      ],
    );
  }

  async assetVolume(
    w: IntentsWindow,
    side: "origin" | "destination",
    topN = 25,
  ): Promise<IntentsResult<Array<Record<string, unknown>>>> {
    assertWindow(w);
    const s = side === "origin" ? "o" : "d";
    const rows = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT ${assetLabel(s)} AS asset, chain_${s} AS chain, canon_${s} IS NOT NULL AS mapped, countIf(status='SUCCESS') AS swaps, ${VOL} AS vol, ${UNK} AS unk
       FROM sw GROUP BY asset, chain, mapped HAVING swaps > 0 ORDER BY vol DESC, swaps DESC LIMIT {top:UInt32}`,
      this.params(w, undefined, { top: topN }),
    );
    return this.ok(
      `intents.volume_by_${side}_asset`,
      `Settled USD volume by ${side} asset and chain (SUCCESS swaps; unknown USD counted separately).`,
      w,
      { kind: "bar", category: "asset", value: "volumeUsdKnown" },
      rows.map((r) => ({
        asset: r.asset,
        chain: r.chain,
        mapped: String(r.mapped) === "1",
        swaps: n(r.swaps),
        volumeUsdKnown: dec(r.vol),
        swapsWithUnknownUsd: n(r.unk),
      })),
      ["intents_swaps", "asset_registry"],
      "grouped by canonical asset (registry-verified) else the provider id prefixed 'unmapped:'",
      ["The same symbol on different chains is kept separate (asset + chain)."],
    );
  }

  /** Origin -> destination chain matrix with directional net flow per chain. */
  async chainFlows(
    w: IntentsWindow,
  ): Promise<
    IntentsResult<{ matrix: Array<Record<string, unknown>>; netFlow: Array<Record<string, unknown>> }>
  > {
    assertWindow(w);
    const rows = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT chain_o AS origin_chain, chain_d AS destination_chain, countIf(status='SUCCESS') AS swaps, ${VOL} AS vol, ${UNK} AS unk,
         countIf(status='REFUNDED') AS refunded, countIf(${TERMINAL}) AS terminal FROM sw GROUP BY chain_o, chain_d HAVING terminal > 0 ORDER BY vol DESC`,
      this.params(w),
    );
    const matrix = rows.map((r) => ({
      originChain: r.origin_chain,
      destinationChain: r.destination_chain,
      swaps: n(r.swaps),
      volumeUsdKnown: dec(r.vol),
      swapsWithUnknownUsd: n(r.unk),
      refundRate: ratio(n(r.refunded), n(r.terminal)),
    }));
    const chains = new Set<string>(
      rows.flatMap((r) => [r.origin_chain as string, r.destination_chain as string]),
    );
    const netFlow = [...chains]
      .map((c) => {
        const out = sum(
          rows.filter((r) => r.origin_chain === c && r.destination_chain !== c).map((r) => r.vol ?? "0"),
        );
        const inn = sum(
          rows.filter((r) => r.destination_chain === c && r.origin_chain !== c).map((r) => r.vol ?? "0"),
        );
        const net = sub(inn, out);
        return {
          chain: c,
          outflowUsdKnown: norm(format(out)),
          inflowUsdKnown: norm(format(inn)),
          netInflowUsdKnown: norm(format(net)),
          _net: net,
        };
      })
      .sort((x, y) => cmp(y._net, x._net) || x.chain.localeCompare(y.chain))
      .map(({ _net, ...rest }) => rest);
    return this.ok(
      "intents.chain_flows",
      "Origin-chain to destination-chain matrix of SUCCESS swaps. Net inflow of a chain = USD routed to it from other chains minus USD routed from it to other chains, both measured on the swap's amountInUsd (same-chain swaps excluded). Directional net flow is a routing balance, not a bridge-reserve change.",
      w,
      { kind: "heatmap", x: "originChain", y: "destinationChain", value: "volumeUsdKnown" },
      { matrix, netFlow },
      ["intents_swaps", "asset_registry"],
      "chain = registry blockchain, else documented asset-id grammar, else 'unknown'",
      ["Rows with chain 'unknown' are kept visible rather than dropped."],
    );
  }

  async assetPairs(w: IntentsWindow, topN = 25): Promise<IntentsResult<Array<Record<string, unknown>>>> {
    assertWindow(w);
    const rows = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT ${assetLabel("o")} AS asset_o, chain_o, ${assetLabel("d")} AS asset_d, chain_d, countIf(status='SUCCESS') AS swaps, ${VOL} AS vol,
         ${UNK} AS unk, countIf(status='SUCCESS' AND usd_in IS NOT NULL) AS known, countIf(status='REFUNDED') AS refunded, countIf(${TERMINAL}) AS terminal
       FROM sw GROUP BY asset_o, chain_o, asset_d, chain_d HAVING swaps > 0 ORDER BY vol DESC, swaps DESC LIMIT {top:UInt32}`,
      this.params(w, undefined, { top: topN }),
    );
    return this.ok(
      "intents.asset_pairs",
      "Observed asset pairs (origin asset+chain -> destination asset+chain) with settled swap count, volume and average size. Observations of completed swaps, not available liquidity.",
      w,
      { kind: "table" },
      rows.map((r) => ({
        originAsset: r.asset_o,
        originChain: r.chain_o,
        destinationAsset: r.asset_d,
        destinationChain: r.chain_d,
        swaps: n(r.swaps),
        volumeUsdKnown: dec(r.vol),
        swapsWithUnknownUsd: n(r.unk),
        avgSizeUsd: n(r.known) > 0 ? ratio(r.vol ?? "0", n(r.known), 2) : null,
        refundRate: ratio(n(r.refunded), n(r.terminal)),
      })),
      ["intents_swaps", "asset_registry"],
      "avgSizeUsd = known USD volume / swaps with known USD (2 digits, exact)",
    );
  }

  async refundRates(
    w: IntentsWindow,
    by: "asset_pair" | "chain_pair" = "chain_pair",
    minTerminal = 100,
    topN = 25,
  ): Promise<IntentsResult<Array<Record<string, unknown>>>> {
    assertWindow(w);
    const key =
      by === "chain_pair"
        ? "chain_o, chain_d"
        : `${assetLabel("o")} AS asset_o, ${assetLabel("d")} AS asset_d`;
    const grp = by === "chain_pair" ? "chain_o, chain_d" : "asset_o, asset_d";
    const rows = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT ${key}, countIf(${TERMINAL}) AS terminal, countIf(status='SUCCESS') AS success, countIf(status='REFUNDED') AS refunded, countIf(status='FAILED') AS failed
       FROM sw GROUP BY ${grp} HAVING terminal >= {min:UInt32} ORDER BY refunded / terminal DESC, terminal DESC LIMIT {top:UInt32}`,
      this.params(w, undefined, { min: minTerminal, top: topN }),
    );
    return this.ok(
      "intents.refund_rate",
      `Refunded share of terminal swaps (SUCCESS+REFUNDED+FAILED) by ${by.replace("_", " ")}. Pairs below ${minTerminal} terminal swaps are omitted (too few to rank).`,
      w,
      { kind: "bar", category: by === "chain_pair" ? "originChain" : "originAsset", value: "refundRate" },
      rows.map((r) => ({
        ...(by === "chain_pair"
          ? { originChain: r.chain_o, destinationChain: r.chain_d }
          : { originAsset: r.asset_o, destinationAsset: r.asset_d }),
        terminalSwaps: n(r.terminal),
        success: n(r.success),
        refunded: n(r.refunded),
        failed: n(r.failed),
        refundRate: ratio(n(r.refunded), n(r.terminal)),
        failedRate: ratio(n(r.failed), n(r.terminal)),
      })),
      ["intents_swaps", "asset_registry"],
      "refunded / terminal, exact 6-digit ratio",
      ["Causes by reason, week, day and chain pair: GET /v1/intents/refund-causes."],
    );
  }

  /**
   * Why swaps were refunded: provider refundReason (side table intents_swap_refunds, copied verbatim from the Explorer item).
   * `NOT_REPORTED` = the provider sent no reason; `NOT_LOADED` = no side-table row (load not run), never a guessed cause.
   */
  async refundCauses(
    w: IntentsWindow,
    by: "reason" | "week" | "day" | "chain_pair" = "reason",
  ): Promise<IntentsResult<Array<Record<string, unknown>>>> {
    assertWindow(w);
    const group =
      by === "reason"
        ? { sel: "", grp: "", ord: "refunded DESC, reason" }
        : by === "week"
          ? {
              sel: "toString(toMonday(day)) AS period,",
              grp: "period,",
              ord: "period, refunded DESC, reason",
            }
          : by === "day"
            ? { sel: "toString(day) AS period,", grp: "period,", ord: "period, refunded DESC, reason" }
            : {
                sel: "chain_o, chain_d,",
                grp: "chain_o, chain_d,",
                ord: "chain_o, chain_d, refunded DESC, reason",
              };
    const rows = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)}, rf AS (SELECT swap_key, refund_reason, refund_type FROM ${this.db}.intents_swap_refunds FINAL)
       SELECT ${group.sel} multiIf(rf.swap_key = '', 'NOT_LOADED', rf.refund_reason IS NULL, 'NOT_REPORTED', rf.refund_reason) AS reason,
              count() AS refunded, ${VOL} AS vol, ${UNK} AS unk
       FROM sw LEFT JOIN rf ON rf.swap_key = sw.swap_key
       WHERE status = 'REFUNDED'
       GROUP BY ${group.grp} reason ORDER BY ${group.ord}`,
      this.params(w),
    );
    const totals = new Map<string, number>();
    const keyOf = (r: Row) => (by === "chain_pair" ? `${r.chain_o}>${r.chain_d}` : (r.period ?? "all"));
    for (const r of rows) totals.set(keyOf(r), (totals.get(keyOf(r)) ?? 0) + n(r.refunded));
    return this.ok(
      "intents.refund_causes",
      `Refunded swaps grouped by the provider's refundReason${by === "reason" ? "" : ` and ${by.replace("_", " ")}`}. share = refunded with this reason / all refunded in the group.`,
      w,
      { kind: "bar", category: "reason", value: "refunded" },
      rows.map((r) => ({
        ...(by === "chain_pair" ? { originChain: r.chain_o, destinationChain: r.chain_d } : {}),
        ...(by === "week" || by === "day" ? { period: r.period } : {}),
        reason: r.reason,
        refunded: n(r.refunded),
        share: ratio(n(r.refunded), totals.get(keyOf(r)) ?? 0),
        refundedUsd: r.vol ?? null,
        swapsWithUnknownUsd: n(r.unk),
      })),
      ["intents_swaps", "intents_swap_refunds", "asset_registry"],
      "count of REFUNDED swaps by provider refundReason; shares are exact 6-digit ratios within each group",
      [
        "refundReason is the provider's label and is not interpreted further.",
        "Volume on refunded swaps is the provider's amountInUsd and may be absent.",
      ],
    );
  }

  async routeUsage(w: IntentsWindow, topN = 25): Promise<IntentsResult<Array<Record<string, unknown>>>> {
    assertWindow(w);
    const rows = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT chain_o, chain_d, deposit_type, recipient_type, count() AS swaps, ${VOL} AS vol, ${UNK} AS unk FROM sw WHERE status = 'SUCCESS'
       GROUP BY chain_o, chain_d, deposit_type, recipient_type ORDER BY swaps DESC LIMIT {top:UInt32}`,
      this.params(w, undefined, { top: topN }),
    );
    const [t] = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT count() AS c FROM sw WHERE status = 'SUCCESS'`,
      this.params(w),
    );
    return this.ok(
      "intents.route_usage",
      "A route = origin chain -> destination chain with how value enters (depositType) and leaves (recipientType): ORIGIN_CHAIN, INTENTS or CONFIDENTIAL_INTENTS. Share is of SUCCESS swaps in the window.",
      w,
      { kind: "table" },
      rows.map((r) => ({
        originChain: r.chain_o,
        destinationChain: r.chain_d,
        depositType: r.deposit_type,
        recipientType: r.recipient_type,
        swaps: n(r.swaps),
        share: ratio(n(r.swaps), n(t?.c)),
        volumeUsdKnown: dec(r.vol),
        swapsWithUnknownUsd: n(r.unk),
      })),
      ["intents_swaps", "asset_registry"],
      "grouped counts",
    );
  }

  async referralUsage(w: IntentsWindow, topN = 20): Promise<IntentsResult<Array<Record<string, unknown>>>> {
    assertWindow(w);
    const rows = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT coalesce(referral, '(none)') AS referral, count() AS swaps, ${VOL} AS vol, ${UNK} AS unk FROM sw WHERE status = 'SUCCESS' GROUP BY referral ORDER BY swaps DESC LIMIT {top:UInt32}`,
      this.params(w, undefined, { top: topN }),
    );
    return this.ok(
      "intents.referral_usage",
      "SUCCESS swaps by Explorer referral label (integrator/channel attribution as reported by the provider; not solver attribution).",
      w,
      { kind: "bar", category: "referral", value: "swaps" },
      rows.map((r) => ({
        referral: r.referral,
        swaps: n(r.swaps),
        volumeUsdKnown: dec(r.vol),
        swapsWithUnknownUsd: n(r.unk),
      })),
      ["intents_swaps"],
      "grouped counts",
    );
  }

  async sizeBuckets(w: IntentsWindow): Promise<IntentsResult<Array<Record<string, unknown>>>> {
    assertWindow(w);
    const rows = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT ${bucketExpr} AS bucket, count() AS swaps, ${VOL} AS vol FROM sw WHERE status = 'SUCCESS' GROUP BY bucket`,
      this.params(w),
    );
    const total = rows.reduce((a, r) => a + n(r.swaps), 0);
    const order = [...SIZE_BUCKETS.map((b) => b.label as string), "unknown_usd"];
    const byLabel = new Map(rows.map((r) => [r.bucket as string, r]));
    return this.ok(
      "intents.size_buckets",
      "SUCCESS swaps by USD size of the deposit (provider amountInUsd). Bounds are lower-inclusive, upper-exclusive: <10, 10-100, 100-1k, 1k-10k, 10k-100k, >=100k, plus 'unknown_usd' when the provider gave no value.",
      w,
      { kind: "bar", x: "bucket", y: "swaps" },
      order
        .filter((l) => byLabel.has(l))
        .map((l) => {
          const r = byLabel.get(l) as Row;
          return {
            bucket: l,
            swaps: n(r.swaps),
            share: ratio(n(r.swaps), total),
            volumeUsdKnown: l === "unknown_usd" ? null : dec(r.vol),
          };
        }),
      ["intents_swaps"],
      "multiIf over Decimal amount_in_usd",
    );
  }

  async trend(
    w: IntentsWindow,
    granularity: "day" | "week" | "month" = "day",
  ): Promise<IntentsResult<Array<Record<string, unknown>>>> {
    assertWindow(w);
    const g = { day: "day", week: "toStartOfWeek(day, 1)", month: "toStartOfMonth(day)" }[granularity];
    const rows = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT toString(${g}) AS period, count() AS swaps, countIf(status='SUCCESS') AS success, countIf(status='REFUNDED') AS refunded, countIf(${TERMINAL}) AS terminal,
         ${VOL} AS vol, ${UNK} AS unk, uniqExact(day) AS days FROM sw GROUP BY period ORDER BY period`,
      this.params(w),
    );
    return this.ok(
      "intents.trend",
      `Swap count, success, refunds and settled USD volume per ${granularity}.`,
      w,
      { kind: "line", x: "period", y: "swaps" },
      rows.map((r) => ({
        period: r.period,
        swaps: n(r.swaps),
        success: n(r.success),
        refunded: n(r.refunded),
        refundRate: ratio(n(r.refunded), n(r.terminal)),
        volumeUsdKnown: dec(r.vol),
        swapsWithUnknownUsd: n(r.unk),
        daysWithData: n(r.days),
      })),
      ["intents_swaps"],
      "periods starting inside the window may include only part of the period; daysWithData shows how many days contributed",
      ["Days that are not complete in coverage.incompleteDays make their period a lower bound."],
    );
  }

  /** IntentsWindow vs the immediately preceding window of equal length, per origin->destination chain pair. */
  async chainPairGrowth(
    w: IntentsWindow,
    minPrev = 50,
    topN = 25,
  ): Promise<IntentsResult<Array<Record<string, unknown>>>> {
    assertWindow(w);
    const len = daysBetween(w.from, w.to);
    const prev: IntentsWindow = { from: addDays(w.from, -len), to: addDays(w.from, -1) };
    const rows = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT chain_o, chain_d, countIf(status='SUCCESS' AND day >= {from2:Date}) AS cur, countIf(status='SUCCESS' AND day < {from2:Date}) AS prev,
         sumIf(usd_in, status='SUCCESS' AND usd_in IS NOT NULL AND day >= {from2:Date}) AS vcur, sumIf(usd_in, status='SUCCESS' AND usd_in IS NOT NULL AND day < {from2:Date}) AS vprev
       FROM sw GROUP BY chain_o, chain_d HAVING cur + prev > 0`,
      { from: prev.from, to: w.to, from2: w.from },
    );
    const data = rows
      .map((r) => ({
        originChain: r.chain_o,
        destinationChain: r.chain_d,
        swaps: n(r.cur),
        previousSwaps: n(r.prev),
        swapGrowthPct: pctChange(String(n(r.cur)), String(n(r.prev))),
        volumeUsdKnown: dec(r.vcur),
        previousVolumeUsdKnown: dec(r.vprev),
        volumeGrowthPct: pctChange(r.vcur ?? "0", r.vprev ?? "0"),
        newPair: n(r.prev) === 0,
        belowMinPrevious: n(r.prev) < minPrev,
      }))
      .filter((r) => !r.belowMinPrevious || r.newPair)
      .sort((a, b) => b.swaps - a.swaps)
      .slice(0, topN);
    return this.ok(
      "intents.chain_pair_growth",
      `SUCCESS swaps and USD volume per chain pair in the window versus the preceding ${len} days (${prev.from}..${prev.to}). Growth % is exact; it is null when the previous value is 0 (newPair = true). Pairs with fewer than ${minPrev} previous swaps are omitted unless new.`,
      w,
      { kind: "bar", category: "originChain", value: "swapGrowthPct" },
      data,
      ["intents_swaps", "asset_registry"],
      "two equal consecutive windows in one scan",
      [
        `Previous window: ${prev.from}..${prev.to}. Its coverage is not repeated here; check /coverage for it.`,
      ],
    );
  }

  async concentrationOf(
    w: IntentsWindow,
    dimension: "origin_asset" | "destination_asset" | "origin_chain" | "destination_chain" | "chain_pair",
    measure: "volume" | "count" = "volume",
    topN = 10,
  ): Promise<IntentsResult<Record<string, unknown>>> {
    assertWindow(w);
    const keyExpr = {
      origin_asset: assetLabel("o"),
      destination_asset: assetLabel("d"),
      origin_chain: "chain_o",
      destination_chain: "chain_d",
      chain_pair: "concat(chain_o, '->', chain_d)",
    }[dimension];
    const val = measure === "volume" ? VOL : "countIf(status='SUCCESS')";
    const rows = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT ${keyExpr} AS k, ${val} AS v FROM sw GROUP BY k HAVING v > 0`,
      this.params(w),
    );
    const c = concentration(
      rows.map((r) => ({ key: r.k as string, value: r.v ?? "0" })),
      topN,
    );
    const [u] = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT ${UNK} AS unk, countIf(status='SUCCESS') AS s FROM sw`,
      this.params(w),
    );
    return this.ok(
      `intents.concentration.${dimension}.${measure}`,
      `Top-${topN} share and Herfindahl-Hirschman index (0-10000) of SUCCESS ${measure === "volume" ? "known USD volume" : "swap count"} across ${dimension.replace("_", " ")}. HHI = 10000 * sum(share^2), exact.`,
      w,
      { kind: "bar", category: "key", value: "share" },
      { ...c, excludedSwapsWithUnknownUsd: measure === "volume" ? n(u?.unk) : 0, settledSwaps: n(u?.s) },
      ["intents_swaps", "asset_registry"],
      "exact BigInt arithmetic over per-group Decimal sums",
      measure === "volume"
        ? ["Concentration is over the known-USD population; swaps without USD are excluded and counted."]
        : [],
    );
  }

  /**
   * Unusual flow changes per chain pair. Method (explicit, see UNUSUAL_METHOD): the last `recentDays` complete days are scored against the
   * `baselineDays` complete days before them using a modified z-score on daily SUCCESS swap counts. Only complete days are used.
   */
  async unusualFlows(
    asOf: string,
    o: { baselineDays?: number; recentDays?: number; topPairs?: number; opts?: UnusualOpts } = {},
  ): Promise<IntentsResult<Record<string, unknown>>> {
    const baselineDays = o.baselineDays ?? 28;
    const recentDays = o.recentDays ?? 7;
    const w: IntentsWindow = assertWindow({
      from: addDays(asOf, -(baselineDays + recentDays) + 1),
      to: asOf,
    });
    const cov = await this.coverage(w);
    const completeSet = new Set<string>();
    const incomplete = new Set([...cov.incompleteDays.map((d) => d.day), ...cov.missingDays]);
    for (let i = 0; i < cov.daysInWindow; i++) {
      const d = addDays(w.from, i);
      if (!incomplete.has(d)) completeSet.add(d);
    }
    const recentFrom = addDays(asOf, -recentDays + 1);
    const rows = await queryRows<Row>(
      this.ch,
      `${swapsCte(this.db, false)} SELECT chain_o, chain_d, toString(day) AS d, countIf(status='SUCCESS') AS c FROM sw GROUP BY chain_o, chain_d, day`,
      this.params(w),
    );
    const byPair = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const k = `${r.chain_o}->${r.chain_d}`;
      if (!byPair.has(k)) byPair.set(k, new Map());
      (byPair.get(k) as Map<string, number>).set(r.d as string, n(r.c));
    }
    const baseDays = [...completeSet].filter((d) => d < recentFrom).sort();
    const recDays = [...completeSet].filter((d) => d >= recentFrom).sort();
    const out: Array<Record<string, unknown>> = [];
    let notScoreable = 0;
    for (const [pair, series] of byPair) {
      const res = detectUnusual(
        baseDays.map((d) => series.get(d) ?? 0),
        recDays.map((d) => ({ day: d, value: series.get(d) ?? 0 })),
        o.opts,
      );
      if (!res.scoreable) {
        notScoreable++;
        continue;
      }
      if (res.anomalies.length)
        out.push({
          pair,
          baselineMedianDailySwaps: res.baselineMedian,
          baselineMad: res.mad,
          anomalies: res.anomalies,
        });
    }
    out.sort(
      (a, b) =>
        Math.abs((b.anomalies as Array<{ score: number }>)[0]?.score ?? 0) -
        Math.abs((a.anomalies as Array<{ score: number }>)[0]?.score ?? 0),
    );
    return this.ok(
      "intents.unusual_flows",
      `Chain pairs whose daily SUCCESS swap count in the last ${recentDays} complete days departs from the preceding ${baselineDays}-day baseline (${UNUSUAL_METHOD.name}, threshold ${UNUSUAL_METHOD.threshold}).`,
      w,
      { kind: "table" },
      {
        method: UNUSUAL_METHOD,
        baselineDaysUsed: baseDays.length,
        recentDaysUsed: recDays.length,
        excludedIncompleteDays: [...incomplete].sort(),
        pairsNotScoreable: notScoreable,
        flagged: o.topPairs ? out.slice(0, o.topPairs) : out.slice(0, 50),
      },
      ["intents_swaps", "asset_registry", "source_coverage"],
      "robust median/MAD scoring on counts; volume is not scored because USD is missing for part of the population",
      [
        "A flag is a statistical deviation, not a finding of cause. Check the day's coverage state before reading it as real.",
      ],
    );
  }

  // ---------- capabilities that the source cannot support ----------

  /**
   * Measured deposit-to-settlement duration for the days covered by the owner-approved BigQuery pilot (table
   * intents_settlement_durations): Explorer createdAt to the block time of the swap's last listed NEAR transaction (validated
   * on the pilot as the completion marker). Only swaps with every listed hash found are measured; the rest are counted, not
   * zero-filled. Days outside the pilot stay CANNOT_COMPUTE, so a window with no covered day falls back to settlementDuration.
   */
  async settlementDurationMeasured(w: IntentsWindow): Promise<IntentsResult<Array<Record<string, unknown>>>> {
    assertWindow(w);
    let rows: Row[] = [];
    try {
      rows = await queryRows<Row>(
        this.ch,
        `SELECT origin_chain AS chain, count() AS swaps, countIf(complete = 1) AS measured, countIf(complete = 0) AS hashes_missing,
                quantileExactIf(0.5)(settlement_ms, complete = 1) AS p50_ms, quantileExactIf(0.95)(settlement_ms, complete = 1) AS p95_ms,
                toString(min(created_day)) AS first_day, toString(max(created_day)) AS last_day
         FROM ${this.db}.intents_settlement_durations FINAL
         WHERE created_day >= {from:Date} AND created_day <= {to:Date} GROUP BY chain ORDER BY measured DESC, chain`,
        { from: w.from, to: w.to },
      );
    } catch {
      rows = [];
    }
    if (rows.length === 0) return this.settlementDuration(w);
    const first = rows.reduce((m, r) => (String(r.first_day) < m ? String(r.first_day) : m), "9999-12-31");
    const last = rows.reduce((m, r) => (String(r.last_day) > m ? String(r.last_day) : m), "0000-00-00");
    return this.ok(
      "intents.settlement_duration",
      "settlement_ms = block time of the swap's last listed NEAR transaction (BigQuery transactions.block_timestamp) minus Explorer createdAt, by origin chain. p50/p95 over swaps with every listed hash found. Measures Explorer createdAt to NEAR inclusion, not the user's wait on the destination chain.",
      w,
      { kind: "bar", category: "originChain", value: "p50Ms" },
      rows.map((r) => ({
        originChain: r.chain,
        swaps: n(r.swaps),
        measured: n(r.measured),
        hashesMissing: n(r.hashes_missing),
        p50Ms: r.measured === "0" ? null : r.p50_ms,
        p95Ms: r.measured === "0" ? null : r.p95_ms,
      })),
      ["intents_settlement_durations", "intents_swaps", "asset_registry"],
      "bounded BigQuery pilot (7 swap days, public era) loaded once; durations computed locally in ClickHouse",
      [
        `Measured only for swap days ${first}..${last} (public era, owner-approved pilot); other days in the window are NOT measured (CANNOT_COMPUTE), never zero.`,
        "Private-settlement swaps (from 2026-10-27) carry boundary hashes, not the swap's own, and are excluded.",
        "Swaps with any listed hash absent from BigQuery are counted in hashesMissing and excluded from the percentiles.",
      ],
    );
  }

  async settlementDuration(w: IntentsWindow): Promise<IntentsCannotCompute> {
    assertWindow(w);
    let alt: IntentsCannotCompute["alternative"] | undefined;
    try {
      const rows = await queryRows<Row>(
        this.ch,
        `SELECT a.origin_chain AS chain, count() AS quotes, quantileExact(0.5)(i.time_estimate_s) AS p50, quantileExact(0.95)(i.time_estimate_s) AS p95
         FROM ${this.db}.quote_intel AS i FINAL INNER JOIN (SELECT route_id, amount_base_units, privacy_mode, scheduled_bucket_utc, attempt_no, argMax(origin_chain, version) AS origin_chain FROM ${this.db}.quote_attempts GROUP BY route_id, amount_base_units, privacy_mode, scheduled_bucket_utc, attempt_no) AS a
           ON a.route_id = i.route_id AND a.amount_base_units = i.amount_base_units AND a.privacy_mode = i.privacy_mode AND a.scheduled_bucket_utc = i.scheduled_bucket_utc AND a.attempt_no = i.attempt_no
         WHERE i.time_estimate_s IS NOT NULL AND toDate(i.scheduled_bucket_utc) >= {from:Date} AND toDate(i.scheduled_bucket_utc) <= {to:Date} GROUP BY chain ORDER BY chain`,
        { from: w.from, to: w.to },
      );
      if (rows.length)
        alt = {
          metric: "intents.quoted_time_estimate_by_origin_chain",
          label:
            "INDICATIVE QUOTED ESTIMATE (seconds) from dry quotes' timeEstimate. It is the provider's prediction, not a measured settlement duration.",
          data: rows.map((r) => ({
            originChain: r.chain,
            quotes: n(r.quotes),
            p50Seconds: r.p50,
            p95Seconds: r.p95,
          })),
        };
    } catch {
      alt = undefined;
    }
    return this.cannot(
      "intents.settlement_duration",
      ["settlement_completed_at (or any second per-swap timestamp)", "deposit_confirmed_at"],
      "The Explorer response has a single timestamp per swap (createdAt). No settlement, completion, update or deposit-confirmation time exists in the schema or in any of the 4,930,000 archived transactions, so deposit-to-settlement duration, and its p50/p95 by source chain, cannot be measured from this source. Deriving it would need block timestamps of the listed transaction hashes (NEAR receipts via BigQuery, which is a billed query awaiting owner approval).",
      [
        SOURCES[0] as string,
        "services/ingestion/src/adapters/explorer-parse.ts ExplorerTx",
        ".data/backfill/raw key scan (no completion-time key)",
      ],
      alt,
      w,
    );
  }

  async solverMetrics(w?: IntentsWindow): Promise<IntentsCannotCompute> {
    const win = w ? assertWindow(w) : undefined;
    return this.cannot(
      "intents.solver_metrics",
      [
        "solver_id / relayer / market-maker identity on a swap",
        "quote_id or correlationId on a swap (quote-to-execution linkage)",
        "fill or settlement timestamp",
      ],
      "Solver share, solver concentration, fill rate, execution quality, quote-to-execution difference and solver latency all need a solver identity per executed swap and a defensible link between a specific quote and its execution. The Explorer swap has neither: no solver field exists, and its only key shared with a real quote (depositAddress) is absent from dry quotes, which are the only quotes Nearesis may request. Joining swaps to quote samples by time or pair similarity is prohibited, so none of these metrics are computed or inferred.",
      [
        ...SOURCES.slice(0, 2),
        "services/ingestion/docs/SOURCES_CHECKED.md (dry:true response lacks depositAddress)",
      ],
      undefined,
      win,
    );
  }

  fieldInventory(): IntentsOk<typeof FIELD_INVENTORY> {
    return {
      status: "OK",
      metric: "intents.field_inventory",
      definition: "What the NEAR Intents Explorer API does and does not identify, per concept.",
      window: null,
      chart: { kind: "table" },
      data: FIELD_INVENTORY,
      coverage: null,
      provenance: {
        source: "Explorer OpenAPI, parser, and a scan of every archived page",
        tables: [],
        asOf: null,
        computedAt: this.now().toISOString(),
        metricVersion: INTENTS_METRICS_VERSION,
        method: "documentation review plus key scan of 4,930,000 archived transactions",
      },
      caveats: [SCOPE_NOTE],
    };
  }

  // ---------- quote intelligence ----------

  async quoteIntelligence(w: IntentsWindow): Promise<IntentsResult<Record<string, unknown>[]>> {
    assertWindow(w);
    const where = `toDate(scheduled_bucket_utc) >= {from:Date} AND toDate(scheduled_bucket_utc) <= {to:Date}`;
    let rows: Row[];
    try {
      rows = await queryRows<Row>(
        this.ch,
        `SELECT route_id, count() AS slots, countIf(availability != 'not_attempted') AS attempts, countIf(availability = 'available') AS available, countIf(availability = 'no_route') AS no_route,
           countIf(availability = 'error') AS errors, countIf(availability = 'not_attempted') AS not_attempted, countIf(rate_limit_status = 'limited') AS rate_limited,
           countIf(signature_status = 'verified') AS sig_verified, countIf(signature_status = 'invalid') AS sig_invalid, countIf(signature_status = 'signature_unverifiable') AS sig_unverifiable,
           quantileExactIf(0.5)(latency_ms, latency_ms IS NOT NULL) AS lat50, quantileExactIf(0.95)(latency_ms, latency_ms IS NOT NULL) AS lat95,
           quantileExactIf(0.5)(toFloat64(usd_implied_cost_bps), usd_implied_cost_bps IS NOT NULL) AS cost50, quantileExactIf(0.95)(toFloat64(usd_implied_cost_bps), usd_implied_cost_bps IS NOT NULL) AS cost95,
           argMaxIf(quoted_effective_rate, quote_timestamp, quoted_effective_rate IS NOT NULL) AS latest_rate, toString(max(quote_timestamp)) AS latest_at, any(provider_version) AS provider_version
         FROM ${this.db}.quote_intel FINAL WHERE ${where} GROUP BY route_id ORDER BY route_id`,
        { from: w.from, to: w.to },
      );
    } catch {
      return this.cannot(
        "intents.quote_intelligence",
        [`${this.db}.quote_intel (run services/ingestion/src/quotes/cli.ts)`],
        "The quote_intel table does not exist yet.",
        [],
        undefined,
        undefined,
      ) as unknown as IntentsResult<Record<string, unknown>[]>;
    }
    const errs = await queryRows<Row>(
      this.ch,
      `SELECT route_id, error_category, count() AS c FROM ${this.db}.quote_intel FINAL WHERE ${where} AND error_category NOT IN ('none') GROUP BY route_id, error_category`,
      { from: w.from, to: w.to },
    );
    const errBy = new Map<string, Record<string, number>>();
    for (const e of errs)
      errBy.set(e.route_id as string, {
        ...(errBy.get(e.route_id as string) ?? {}),
        [e.error_category as string]: n(e.c),
      });
    const data = rows.map((r) => ({
      routeId: r.route_id,
      slots: n(r.slots),
      attempts: n(r.attempts),
      notAttempted: n(r.not_attempted),
      availabilityRate: ratio(n(r.available), n(r.attempts)),
      available: n(r.available),
      noRoute: n(r.no_route),
      errors: n(r.errors),
      errorCategories: errBy.get(r.route_id as string) ?? {},
      rateLimited: n(r.rate_limited),
      latencyMsP50: r.lat50 && n(r.attempts) > 0 ? n(r.lat50) : null,
      latencyMsP95: r.lat95 && n(r.attempts) > 0 ? n(r.lat95) : null,
      usdImpliedCostBpsP50: n(r.available) > 0 ? r.cost50 : null,
      usdImpliedCostBpsP95: n(r.available) > 0 ? r.cost95 : null,
      latestQuotedEffectiveRate: r.latest_rate && r.latest_rate !== "0" ? dec(r.latest_rate) : null,
      latestQuoteAt: r.latest_at && r.latest_at.startsWith("19") ? null : (r.latest_at ?? null),
      signatures: {
        verified: n(r.sig_verified),
        invalid: n(r.sig_invalid),
        signatureUnverifiable: n(r.sig_unverifiable),
      },
      providerVersion: r.provider_version,
    }));
    const ok = await this.ok(
      "intents.quote_intelligence",
      "Per route over dry 1Click quote samples: availability (available / no route / error / not attempted), response latency p50/p95, indicative USD-implied cost in bps, latest quoted effective rate, error categories, rate-limit hits and signature verification. Every number describes INDICATIVE quotes; none is an executed outcome.",
      w,
      { kind: "table" },
      data,
      ["quote_intel", "quote_attempts"],
      "derived from quote_attempts and archived raw quote bodies; signature = ed25519 over base58(sha256(stable json)) with the provider's pinned key",
      [
        "Signature scheme: https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature; the key is the constant pinned in the provider's official SDK (the docs page names none).",
        "Latency and cost percentiles are float statistics; rates are exact decimals.",
        "Rate-limit status rests on HTTP 429 only: the sampler archives bodies, not response headers.",
      ],
    );
    return { ...ok, coverage: null };
  }
}
