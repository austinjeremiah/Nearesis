import type { ClickHouseClient } from "@clickhouse/client";
import type {
  AccountDataSource,
  AccountDay,
  AccountProfile,
  EntitySignerDay,
  HeadAccountDay,
  HeadAccountRow,
  RetentionCell,
} from "./types.ts";

const D = /^\d{4}-\d{2}-\d{2}$/;
const check = (s: string): string => {
  if (!D.test(s)) throw new Error("date must be YYYY-MM-DD");
  return s;
};

type R = Record<string, string | number>;
const n = (v: unknown): number => Number(v);

/** ClickHouse-backed source over nearesis_live. Values are bound as typed query parameters; UInt64 returned as strings then converted. */
export class ClickHouseAccountSource implements AccountDataSource {
  constructor(private readonly ch: ClickHouseClient) {}

  private async rows(query: string, params: Record<string, unknown> = {}): Promise<R[]> {
    const rs = await this.ch.query({
      query,
      query_params: params,
      format: "JSONEachRow",
      clickhouse_settings: { output_format_json_quote_64bit_integers: 0, date_time_output_format: "simple" },
    });
    return (await rs.json()) as R[];
  }

  async window() {
    const cov = await this.rows(
      "SELECT toString(day) AS d FROM source_coverage FINAL WHERE dataset = 'account_daily_new_returning' AND state = 'complete' ORDER BY d",
    );
    if (cov.length === 0) return null;
    const w = await this.rows(
      "SELECT toString(min(window_start)) AS ws, max(head_threshold) AS h FROM account_daily_tail FINAL",
    );
    const days = cov.map((r) => String(r.d));
    return {
      windowStart: String(w[0]?.ws ?? days[0]),
      from: days[0]!,
      to: days[days.length - 1]!,
      days,
      headThreshold: n(w[0]?.h ?? 100),
    };
  }

  async days(from: string, to: string): Promise<AccountDay[]> {
    const rs = await this.rows(
      `SELECT toString(a.block_date) AS d, a.signers_all, a.tx_all, a.tx_intents, a.tx_bridge, a.signers_with_intents, a.signers_organic, a.tx_organic,
              a.new_signers, a.returning_signers, a.new_tx, a.returning_tx, a.top10_tx, a.top1pct_signer_count, a.top1pct_tx, a.top5pct_signer_count, a.top5pct_tx,
              t.tail_signers, t.tail_tx, t.head_threshold,
              coalesce(h.hn, 0) AS head_n, coalesce(h.htx, 0) AS head_tx
       FROM account_daily_new_returning AS a FINAL
       INNER JOIN account_daily_tail AS t FINAL ON t.block_date = a.block_date
       LEFT JOIN (SELECT block_date, count() AS hn, sum(tx_organic) AS htx FROM account_daily_head FINAL
                  WHERE block_date >= {f:Date} AND block_date <= {t:Date} GROUP BY block_date) AS h ON h.block_date = a.block_date
       WHERE a.block_date >= {f:Date} AND a.block_date <= {t:Date} ORDER BY a.block_date`,
      { f: check(from), t: check(to) },
    );
    return rs.map((r) => ({
      date: String(r.d),
      signersAll: n(r.signers_all),
      txAll: n(r.tx_all),
      txIntents: n(r.tx_intents),
      txBridge: n(r.tx_bridge),
      signersWithIntents: n(r.signers_with_intents),
      signersOrganic: n(r.signers_organic),
      txOrganic: n(r.tx_organic),
      newSigners: n(r.new_signers),
      returningSigners: n(r.returning_signers),
      newTx: n(r.new_tx),
      returningTx: n(r.returning_tx),
      top10Tx: n(r.top10_tx),
      top1PctSigners: n(r.top1pct_signer_count),
      top1PctTx: n(r.top1pct_tx),
      top5PctSigners: n(r.top5pct_signer_count),
      top5PctTx: n(r.top5pct_tx),
      headSigners: n(r.head_n),
      headTx: n(r.head_tx),
      tailSigners: n(r.tail_signers),
      tailTx: n(r.tail_tx),
      headThreshold: n(r.head_threshold),
    }));
  }

  async retention(): Promise<RetentionCell[]> {
    const rs = await this.rows(
      "SELECT toString(cohort_week) AS c, toString(active_week) AS a, signers FROM account_cohort_week_retention FINAL ORDER BY c, a",
    );
    return rs.map((r) => ({ cohortWeek: String(r.c), activeWeek: String(r.a), signers: n(r.signers) }));
  }

  async headAccounts(from: string, to: string, limit: number): Promise<HeadAccountRow[]> {
    const rs = await this.rows(
      `SELECT signer_account_id AS account, count() AS head_days, sum(tx_organic) AS tx, max(tx_organic) AS max_day,
              toString(min(block_date)) AS first_day, toString(max(block_date)) AS last_day
       FROM account_daily_head FINAL WHERE block_date >= {f:Date} AND block_date <= {t:Date}
       GROUP BY signer_account_id ORDER BY tx DESC, account LIMIT {l:UInt32}`,
      { f: check(from), t: check(to), l: limit },
    );
    return rs.map((r) => ({
      account: String(r.account),
      headDays: n(r.head_days),
      txOrganic: n(r.tx),
      maxDayTx: n(r.max_day),
      firstHeadDay: String(r.first_day),
      lastHeadDay: String(r.last_day),
    }));
  }

  async headDays(account: string, from: string, to: string): Promise<HeadAccountDay[]> {
    const rs = await this.rows(
      "SELECT toString(block_date) AS d, tx_organic FROM account_daily_head FINAL WHERE signer_account_id = {a:String} AND block_date >= {f:Date} AND block_date <= {t:Date} ORDER BY d",
      { a: account, f: check(from), t: check(to) },
    );
    return rs.map((r) => ({ date: String(r.d), txOrganic: n(r.tx_organic) }));
  }

  async profile(account: string): Promise<AccountProfile | null> {
    const rs = await this.rows(
      "SELECT signer_account_id AS a, toString(first_seen_in_window) AS f, toString(last_seen_in_window) AS l, active_days, tx_organic, head_days FROM account_head_profile FINAL WHERE signer_account_id = {a:String}",
      { a: account },
    );
    const r = rs[0];
    return r
      ? {
          account: String(r.a),
          firstSeenInWindow: String(r.f),
          lastSeenInWindow: String(r.l),
          activeDays: n(r.active_days),
          txOrganic: n(r.tx_organic),
          headDays: n(r.head_days),
        }
      : null;
  }

  async entityDays(entityBucket: string, from: string, to: string): Promise<EntitySignerDay[]> {
    const rs = await this.rows(
      "SELECT toString(block_date) AS d, signers_all, tx_all, signers_organic, tx_organic FROM entity_daily_signers FINAL WHERE entity_bucket = {e:String} AND block_date >= {f:Date} AND block_date <= {t:Date} ORDER BY d",
      { e: entityBucket, f: check(from), t: check(to) },
    );
    return rs.map((r) => ({
      date: String(r.d),
      signersAll: n(r.signers_all),
      txAll: n(r.tx_all),
      signersOrganic: n(r.signers_organic),
      txOrganic: n(r.tx_organic),
    }));
  }
}
