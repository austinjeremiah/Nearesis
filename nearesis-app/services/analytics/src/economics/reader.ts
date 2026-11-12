import type { ClickHouseClient } from "../ch.ts";
import { queryRows } from "../ch.ts";
import {
  dailyFeeTotals,
  effectivePriceYoctoPerGas,
  executionIntensity,
  feePercentiles,
  feeWithUsd,
  type OutcomeRow,
  type TxDayRow,
} from "./metrics.ts";
import type { PriceSource, UsdValue } from "./units.ts";

/**
 * Read model over the loaded `near_economics_*` tables (exact strings; no float path). Nothing here is named revenue:
 * the execution fee is what the runtime deducted for execution, split modelling is out of scope for these reads.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const ECONOMICS_REGIME_CAVEAT =
  "Fee regime depends on the protocol version: up to version 86 the runtime credits a modelled 30% of burnt gas to the called contract; from version 87 (mainnet activation date unverified) all of it is burnt. These reads report the gross execution fee (the source's tokens_burnt) and make no burnt/reward split. It is never protocol revenue.";
export const PRECISION_CAVEAT =
  "tokens_burnt is FLOAT64 at the source (BigQuery): amounts above ~9e15 yocto are rounded at the source (relative error at most 2^-53 per value). Sums are exact over those stored doubles and carried as decimal strings (token_precision = source_float64).";

type Row = Record<string, string | null>;

export type EconomicsWindow = { from: string; to: string };

export class EconomicsReader {
  constructor(
    private readonly ch: ClickHouseClient,
    private readonly db: string,
  ) {}

  /** Newest loaded day and the window of `days` ending there (null when nothing is loaded). */
  async defaultWindow(days: number): Promise<EconomicsWindow | null> {
    const [r] = await queryRows<Row>(
      this.ch,
      `SELECT toString(max(block_date)) AS d, count() AS c FROM ${this.db}.near_economics_outcomes_daily`,
    );
    if (!r || r.c === "0" || !r.d) return null;
    const t = Date.parse(`${r.d}T00:00:00Z`) - (days - 1) * 86_400_000;
    return { from: new Date(t).toISOString().slice(0, 10), to: r.d };
  }

  private assertWindow(w: EconomicsWindow): void {
    if (!DAY.test(w.from) || !DAY.test(w.to) || w.from > w.to) throw new Error("invalid window");
  }

  /** NEAR/USD daily-close candles of CoinGecko inside the window, keyed by UTC day. */
  async prices(w: EconomicsWindow): Promise<Map<string, PriceSource>> {
    const rows = await queryRows<Row>(
      this.ch,
      `SELECT toString(day) AS dstr, toString(argMax(close, version)) AS closed, toString(argMax(bucket_start, version)) AS ts
         FROM ${this.db}.price_candles WHERE provider = 'coingecko' AND symbol = 'NEAR' AND quote_currency = 'usd' AND interval = '1d'
          AND day >= {from:Date} AND day <= {to:Date} GROUP BY day`,
      w,
    ).catch(() => [] as Row[]);
    const m = new Map<string, PriceSource>();
    for (const r of rows) {
      if (!r.dstr || !r.closed || /e/i.test(r.closed)) continue;
      m.set(r.dstr, {
        provider: "coingecko",
        symbol: "NEAR",
        priceUsd: r.closed,
        priceTimestampUTC: new Date(Date.parse(`${r.ts!.replace(" ", "T")}Z`)).toISOString(),
        method: "coingecko_daily_close_utc",
      });
    }
    return m;
  }

  private async outcomes(w: EconomicsWindow): Promise<OutcomeRow[]> {
    const rows = await queryRows<OutcomeRow & { dstr: string }>(
      this.ch,
      `SELECT toString(block_date) AS dstr, executor_account_id, outcome_kind, status_class, toString(sum(outcomes)) AS outcomes,
              toString(sum(gas_burnt)) AS gas_burnt, toString(sum(tokens_burnt_yocto)) AS tokens_burnt_yocto
         FROM ${this.db}.near_economics_outcomes_daily FINAL WHERE block_date >= {from:Date} AND block_date <= {to:Date}
        GROUP BY block_date, executor_account_id, outcome_kind, status_class`,
      w,
    );
    return rows.map((r) => ({ ...r, block_date: r.dstr }));
  }

  /** Coverage per dataset (source_coverage) and the recorded quality gaps for the window. */
  async coverage(w: EconomicsWindow): Promise<Record<string, unknown>> {
    const cov = await queryRows<Row>(
      this.ch,
      `SELECT dataset, state, toString(count()) AS days, toString(min(day)) AS first_day, toString(max(day)) AS last_day
         FROM ${this.db}.source_coverage FINAL WHERE provider_id = 'near-bigquery' AND dataset LIKE 'near_economics_%'
          AND day >= {from:Date} AND day <= {to:Date} GROUP BY dataset, state ORDER BY dataset, state`,
      w,
    ).catch(() => [] as Row[]);
    const gaps = await queryRows<Row>(
      this.ch,
      `SELECT dataset, state, reason_code, toString(count()) AS days, toString(min(from_utc)) AS first_day, toString(max(from_utc)) AS last_day
         FROM ${this.db}.quality_gaps FINAL WHERE provider_id = 'near-bigquery' AND dataset LIKE 'near_economics_%'
          AND toDate(from_utc) >= {from:Date} AND toDate(from_utc) <= {to:Date} GROUP BY dataset, state, reason_code ORDER BY dataset, reason_code`,
      w,
    ).catch(() => [] as Row[]);
    const loaded = await queryRows<Row>(
      this.ch,
      `SELECT 'outcomes' AS t, toString(count()) AS c FROM ${this.db}.near_economics_outcomes_daily WHERE block_date >= {from:Date} AND block_date <= {to:Date}
       UNION ALL SELECT 'conversion', toString(count()) FROM ${this.db}.near_economics_conversion_daily WHERE block_date >= {from:Date} AND block_date <= {to:Date}
       UNION ALL SELECT 'gas_price', toString(count()) FROM ${this.db}.near_economics_gas_price_daily WHERE block_date >= {from:Date} AND block_date <= {to:Date}
       UNION ALL SELECT 'tx_daily', toString(count()) FROM ${this.db}.near_economics_tx_daily WHERE block_date >= {from:Date} AND block_date <= {to:Date}
       UNION ALL SELECT 'top_tx', toString(count()) FROM ${this.db}.near_economics_top_tx WHERE block_date >= {from:Date} AND block_date <= {to:Date}`,
      w,
    ).catch(() => [] as Row[]);
    return {
      source: "near-bigquery",
      sourceCoverage: cov.map((c) => ({
        dataset: c.dataset,
        state: c.state,
        days: Number(c.days),
        firstDay: c.first_day,
        lastDay: c.last_day,
      })),
      qualityGaps: gaps.map((g) => ({
        dataset: g.dataset,
        state: g.state,
        reasonCode: g.reason_code,
        days: Number(g.days),
        firstDay: g.first_day,
        lastDay: g.last_day,
      })),
      loadedRows: Object.fromEntries(loaded.map((r) => [r.t, Number(r.c)])),
    };
  }

  private envelope(
    metric: string,
    w: EconomicsWindow,
    data: unknown,
    coverage: Record<string, unknown>,
    caveats: string[] = [],
  ) {
    return {
      status: "OK" as const,
      metric,
      window: w,
      precision: "source_float64" as const,
      feeRegime: {
        basis: "gross_execution_fee",
        note: ECONOMICS_REGIME_CAVEAT,
        protocolVersionBoundary: 87,
        activationVerified: false,
      },
      data,
      coverage,
      caveats: [PRECISION_CAVEAT, ECONOMICS_REGIME_CAVEAT, ...caveats],
      provenance: {
        tables: [
          "near_economics_outcomes_daily",
          "near_economics_conversion_daily",
          "near_economics_gas_price_daily",
        ],
        priceSource: "coingecko NEAR/usd 1d candles (price_candles)",
        computedAt: new Date().toISOString(),
      },
    };
  }

  private usd(
    fee: string,
    price: PriceSource | undefined,
  ): {
    usd: UsdValue["usd"] | null;
    usdConversion: UsdValue["conversion"] | null;
    usdUnavailableReason: string | null;
  } {
    const f = feeWithUsd(fee, price ?? null);
    return {
      usd: f.usd?.usd ?? null,
      usdConversion: f.usd?.conversion ?? null,
      usdUnavailableReason: f.usdUnavailableReason,
    };
  }

  /** Daily gas burnt, tokens burnt (exact yocto), effective price, conversion vs receipt-only burn, USD where priced. */
  async daily(w: EconomicsWindow) {
    this.assertWindow(w);
    const [outs, conv, gp, prices, coverage] = await Promise.all([
      this.outcomes(w),
      queryRows<Row>(
        this.ch,
        `SELECT toString(block_date) AS dstr, toString(sum(txs)) AS txs, toString(sum(conversion_gas)) AS gas, toString(sum(conversion_tokens_yocto)) AS tokens
           FROM ${this.db}.near_economics_conversion_daily FINAL WHERE scope = 'day' AND block_date >= {from:Date} AND block_date <= {to:Date} GROUP BY block_date`,
        w,
      ),
      queryRows<Row>(
        this.ch,
        `SELECT toString(block_date) AS dstr, toString(blocks) AS nblocks, toString(min_gas_price_yocto) AS min_p, toString(max_gas_price_yocto) AS max_p,
                toString(sum_gas_price_yocto) AS sum_p, toString(distinct_prices) AS distinct_prices
           FROM ${this.db}.near_economics_gas_price_daily FINAL WHERE block_date >= {from:Date} AND block_date <= {to:Date}`,
        w,
      ),
      this.prices(w),
      this.coverage(w),
    ]);
    const convBy = new Map(conv.map((c) => [c.dstr!, c]));
    const gpBy = new Map(gp.map((g) => [g.dstr!, g]));
    const rows = dailyFeeTotals(outs).map((d) => {
      const c = convBy.get(d.day);
      const g = gpBy.get(d.day);
      const price = prices.get(d.day);
      const convGas = c ? BigInt(c.gas!) : null;
      const convTok = c ? BigInt(c.tokens!) : null;
      const totGas = BigInt(d.gasUnits);
      const totTok = BigInt(d.executionFeeYocto);
      const burningGas = totGas - BigInt(d.zeroTokenGasUnits);
      return {
        day: d.day,
        gasBurnt: d.gasUnits,
        tokensBurntYocto: d.executionFeeYocto,
        tokensBurntNear: d.executionFeeNear,
        outcomes: d.outcomes,
        zeroTokenGasUnits: d.zeroTokenGasUnits,
        effectiveYoctoPerGas: effectivePriceYoctoPerGas(d.executionFeeYocto, burningGas.toString()),
        gasPrice: g
          ? {
              blocks: g.nblocks,
              minYoctoPerGas: g.min_p,
              maxYoctoPerGas: g.max_p,
              meanYoctoPerGas:
                BigInt(g.nblocks!) === 0n ? null : (BigInt(g.sum_p!) / BigInt(g.nblocks!)).toString(),
              distinctPrices: g.distinct_prices,
            }
          : null,
        conversion: c
          ? {
              txs: c.txs,
              gasBurnt: c.gas,
              tokensBurntYocto: c.tokens,
              receiptOnlyGasBurnt:
                convGas !== null && totGas >= convGas ? (totGas - convGas).toString() : null,
              receiptOnlyTokensBurntYocto:
                convTok !== null && totTok >= convTok ? (totTok - convTok).toString() : null,
              basisNote:
                "receipt-only = execution-day total minus transaction-day conversion burn; the two bases differ at day edges, so the difference is an implied bound, not an equality.",
            }
          : null,
        executionIntensity: c
          ? (({ gasPerTx, feeYoctoPerTx }) => ({
              gasPerTx,
              feeYoctoPerTx,
              basis:
                "execution-day gas and fee over transaction-day transaction count (bases differ at day edges)",
            }))(
              executionIntensity({
                txs: c.txs!,
                total_gas: d.gasUnits,
                total_tokens_yocto: d.executionFeeYocto,
                receipts: "0",
              }),
            )
          : null,
        ...this.usd(d.executionFeeYocto, price),
      };
    });
    return this.envelope("economics.daily", w, rows, coverage, [
      "USD uses the CoinGecko NEAR/USD daily close of the same UTC day (candle bucket start as timestamp); days without a candle have usd null with NO_TIMESTAMPED_PRICE.",
      "Percentiles per transaction need near_economics_tx_daily, which is not loaded: see /v1/economics/percentiles.",
    ]);
  }

  async totals(w: EconomicsWindow) {
    const d = (await this.daily(w)) as ReturnType<EconomicsReader["envelope"]> & {
      data: Array<{ gasBurnt: string; tokensBurntYocto: string; usd: string | null; day: string }>;
    };
    let g = 0n;
    let t = 0n;
    let usd = 0n;
    let priced = 0;
    for (const r of d.data) {
      g += BigInt(r.gasBurnt);
      t += BigInt(r.tokensBurntYocto);
      if (r.usd !== null) {
        usd += BigInt(r.usd.replace(".", ""));
        priced++;
      }
    }
    const scale = 6;
    const pad = usd.toString().padStart(scale + 1, "0");
    return {
      ...d,
      metric: "economics.totals",
      data: {
        days: d.data.length,
        gasBurnt: g.toString(),
        tokensBurntYocto: t.toString(),
        usd: priced === d.data.length && priced > 0 ? `${pad.slice(0, -scale)}.${pad.slice(-scale)}` : null,
        usdUnavailableReason: priced === d.data.length && priced > 0 ? null : "NO_TIMESTAMPED_PRICE",
        pricedDays: priced,
      },
    };
  }

  /** Gas and fee by executing account (top N of the window), plus the folded remainder. */
  async receivers(w: EconomicsWindow, top: number) {
    this.assertWindow(w);
    const [rows, coverage] = await Promise.all([
      queryRows<Row>(
        this.ch,
        `SELECT executor_account_id AS account, toString(sum(gas_burnt)) AS gas, toString(sum(tokens_burnt_yocto)) AS tokens
           FROM ${this.db}.near_economics_outcomes_daily FINAL WHERE block_date >= {from:Date} AND block_date <= {to:Date} AND outcome_kind = 'BURNING'
          GROUP BY executor_account_id ORDER BY sum(tokens_burnt_yocto) DESC, executor_account_id LIMIT {top:UInt32}`,
        { ...w, top },
      ),
      this.coverage(w),
    ]);
    const [tot] = await queryRows<Row>(
      this.ch,
      `SELECT toString(sum(gas_burnt)) AS gas, toString(sum(tokens_burnt_yocto)) AS tokens FROM ${this.db}.near_economics_outcomes_daily FINAL
        WHERE block_date >= {from:Date} AND block_date <= {to:Date}`,
      w,
    );
    const total = BigInt(tot?.tokens ?? "0");
    const items = rows.map((r) => ({
      account: r.account,
      folded: r.account === "__below_threshold__",
      gasBurnt: r.gas,
      tokensBurntYocto: r.tokens,
      feeShareBps: total === 0n ? null : ((BigInt(r.tokens!) * 10_000n) / total).toString(),
    }));
    return this.envelope(
      "economics.receivers",
      w,
      { totalGasBurnt: tot?.gas ?? "0", totalTokensBurntYocto: total.toString(), top, items },
      coverage,
      [
        "Executor account is the signer for a transaction outcome and the receiver for a receipt outcome. Accounts below the load threshold are folded into __below_threshold__.",
        "Ranked by tokens burnt over the window on BURNING outcomes; USD is not attached per account (a window sum has no single timestamped price).",
      ],
    );
  }

  /** Per-transaction percentiles exist only where near_economics_tx_daily is loaded; otherwise an honest empty answer. */
  async percentiles(w: EconomicsWindow) {
    this.assertWindow(w);
    const rows = await queryRows<TxDayRow & Row>(
      this.ch,
      `SELECT toString(block_date) AS dstr, toString(txs) AS txs, toString(receipts) AS receipts, toString(total_gas) AS total_gas,
              toString(total_tokens_yocto) AS total_tokens_yocto, toString(conversion_gas) AS conversion_gas, toString(conversion_tokens_yocto) AS conversion_tokens_yocto,
              toString(receipt_gas) AS receipt_gas, toString(receipt_tokens_yocto) AS receipt_tokens_yocto,
              toString(tokens_p50) AS tokens_p50, toString(tokens_p90) AS tokens_p90, toString(tokens_p99) AS tokens_p99, toString(tokens_p999) AS tokens_p999,
              toString(gas_p50) AS gas_p50, toString(gas_p90) AS gas_p90, toString(gas_p99) AS gas_p99, toString(gas_p999) AS gas_p999, percentile_method
         FROM ${this.db}.near_economics_tx_daily FINAL WHERE block_date >= {from:Date} AND block_date <= {to:Date} ORDER BY block_date`,
      w,
    ).catch(() => [] as Array<TxDayRow & Row>);
    const coverage = await this.coverage(w);
    const data = rows.map((r) => ({
      day: r.dstr,
      transactions: r.txs,
      intensity: executionIntensity(r),
      percentiles: feePercentiles(r),
    }));
    return {
      ...this.envelope("economics.percentiles", w, data, coverage, [
        data.length === 0
          ? "Per-transaction percentiles are not loaded for this window (near_economics_tx_daily is empty; the lean load does not include it). No value is estimated."
          : "Percentiles are approximate (see percentile_method).",
      ]),
      loaded: data.length > 0,
      ...(data.length === 0 ? { unavailableReason: "TX_DAILY_NOT_LOADED" } : {}),
    };
  }
}
