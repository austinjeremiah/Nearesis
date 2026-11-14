import { INTENTS_VERIFIER_RECEIVERS } from "../backfill/account-sql.ts";
import { addDays } from "../backfill/plan.ts";
import { DISCOVERY_ALL } from "./fees-sql.ts";

/**
 * Pure derivation of the thesis fee series from frozen BigQuery result rows (no I/O, no BigQuery).
 * Amounts: tokens_burnt is FLOAT64 yoctoNEAR in the public dataset (see docs/economics/SEMANTICS.md); sums are exact BIGNUMERIC
 * strings from BigQuery and are handled here as BigInt. NEAR = yocto / 10^24, printed exactly (no float arithmetic anywhere).
 *
 * Protocol facts for the "toll" reading (cited, not asserted from memory): the contract reward (30% of burnt gas to the called
 * contract) is documented as 30% up to protocol version 86 and 0% from 87 (https://github.com/near/nearcore/blob/master/docs/architecture/how/gas.md,
 * see docs/economics/SEMANTICS.md). The activation date of version 87 on mainnet is NOT verified here, so this module never
 * splits tokens_burnt into burnt vs paid-to-contract: every figure is the gross `tokens_burnt` of the outcome.
 */
export const YOCTO = 10n ** 24n;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type Cell = string | null;
export interface Table {
  columns: string[];
  data: Cell[][];
}
export type Row = Record<string, Cell>;
export const rowsOf = (t: Table): Row[] =>
  t.data.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i] ?? null])));

export function big(v: Cell | undefined): bigint {
  if (v === null || v === undefined || v === "") return 0n;
  if (!/^-?\d+(\.0+)?$/.test(v)) throw new Error(`not an integer string: ${v}`);
  return BigInt(v.split(".")[0] as string);
}

/** Exact decimal NEAR string of a yoctoNEAR integer string (trailing zeros trimmed, at least one digit). */
export function yoctoToNear(y: string | bigint): string {
  const v = typeof y === "bigint" ? y : big(y);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const int = a / YOCTO;
  const frac = (a % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

export interface Dec {
  n: bigint;
  scale: number;
}
/** Plain decimal (no exponent, no sign) to scaled integer. */
export function parseDec(s: string): Dec {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not a plain decimal: ${s}`);
  const frac = m[2] ?? "";
  return { n: BigInt(`${m[1]}${frac}`), scale: frac.length };
}

/** num/den rounded half-even to `decimals` places, printed exactly. den > 0, num >= 0. */
export function divDecimal(num: bigint, den: bigint, decimals: number): string {
  if (den <= 0n || num < 0n) throw new Error("divDecimal needs den > 0 and num >= 0");
  const scaled = num * 10n ** BigInt(decimals);
  let q = scaled / den;
  const r = scaled % den;
  if (2n * r > den || (2n * r === den && q % 2n === 1n)) q += 1n;
  const s = q.toString().padStart(decimals + 1, "0");
  return decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/** USD value of a yocto amount at a decimal USD price per NEAR, 6 decimals. */
export function usdOf(yocto: bigint, price: string): string {
  const p = parseDec(price);
  return divDecimal(yocto * p.n, YOCTO * 10n ** BigInt(p.scale), 6);
}

/** Basis points of settled value: (burn NEAR x price USD) / volume USD x 10^4, 8 decimals; null when the volume is zero. */
export function takeRateBps(burnYocto: bigint, price: string, volumeUsd: string): string | null {
  const p = parseDec(price);
  const v = parseDec(volumeUsd);
  if (v.n === 0n) return null;
  return divDecimal(
    burnYocto * p.n * 10n ** BigInt(v.scale) * 10_000n,
    YOCTO * 10n ** BigInt(p.scale) * v.n,
    8,
  );
}

const pct = (num: bigint, den: bigint, decimals = 6): string | null =>
  den === 0n ? null : divDecimal(num * 100n, den, decimals);

export function daysBetween(from: string, last: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---- chunk records -> daily maps ------------------------------------------------------------------------------------------

export interface DayTotal {
  date: string;
  outcomes: bigint;
  gas: bigint;
  tokens: bigint;
  nullGas: bigint;
  nullTokens: bigint;
  fractionalGas: bigint;
}
export interface ExRow {
  date: string;
  account: string;
  n: bigint;
  gas: bigint;
  tokens: bigint;
  rank: number | null;
}
export interface TopRow {
  chunk: string; // chunk id
  chunkFrom: string;
  account: string;
  n: bigint;
  gas: bigint;
  tokens: bigint;
  rank: number;
}
export interface OutcomeChunk {
  id: string;
  from: string;
  to: string;
  table: Table;
}

export interface OutcomesData {
  days: Map<string, DayTotal>;
  ex: Map<string, Map<string, ExRow>>; // date -> account -> row
  omft: Map<string, { n: bigint; gas: bigint; tokens: bigint }>;
  top: TopRow[];
  chunks: Array<{ id: string; from: string; to: string }>;
}

/** Reads outcome chunk tables. A day (or a day+account) appearing twice means overlapping chunks and is an error. */
export function collectOutcomes(chunks: OutcomeChunk[]): OutcomesData {
  const out: OutcomesData = { days: new Map(), ex: new Map(), omft: new Map(), top: [], chunks: [] };
  for (const c of chunks) {
    out.chunks.push({ id: c.id, from: c.from, to: c.to });
    for (const r of rowsOf(c.table)) {
      const date = r.block_date as string | null;
      if (r.kind === "day") {
        if (!date || !DAY_RE.test(date) || out.days.has(date))
          throw new Error(`bad or duplicate day row ${date}`);
        out.days.set(date, {
          date,
          outcomes: big(r.n),
          gas: big(r.gas),
          tokens: big(r.tokens_yocto),
          nullGas: big(r.null_gas),
          nullTokens: big(r.null_tokens),
          fractionalGas: big(r.fractional_gas),
        });
      } else if (r.kind === "ex") {
        const d = date as string;
        const m = out.ex.get(d) ?? new Map<string, ExRow>();
        const account = r.account as string;
        if (m.has(account)) throw new Error(`duplicate ex row ${d} ${account}`);
        m.set(account, {
          date: d,
          account,
          n: big(r.n),
          gas: big(r.gas),
          tokens: big(r.tokens_yocto),
          rank: r.day_rank === null ? null : Number(r.day_rank),
        });
        out.ex.set(d, m);
      } else if (r.kind === "omft") {
        out.omft.set(date as string, { n: big(r.n), gas: big(r.gas), tokens: big(r.tokens_yocto) });
      } else if (r.kind === "top") {
        out.top.push({
          chunk: c.id,
          chunkFrom: c.from,
          account: r.account as string,
          n: big(r.n),
          gas: big(r.gas),
          tokens: big(r.tokens_yocto),
          rank: Number(r.day_rank),
        });
      }
    }
  }
  return out;
}

export interface BlocksDay {
  date: string;
  blocks: bigint;
  min: string | null;
  max: string | null;
  sum: bigint;
}
export function collectBlocks(tables: Table[]): Map<string, BlocksDay> {
  const m = new Map<string, BlocksDay>();
  for (const t of tables)
    for (const r of rowsOf(t)) {
      const date = r.block_date as string;
      if (m.has(date)) throw new Error(`duplicate blocks day ${date}`);
      m.set(date, {
        date,
        blocks: big(r.blocks),
        min: r.min_gas_price ?? null,
        max: r.max_gas_price ?? null,
        sum: big(r.sum_gas_price),
      });
    }
  return m;
}

export interface TxDay {
  date: string;
  txs: bigint;
  gas: bigint;
  tokens: bigint;
}
export interface TxData {
  days: Map<string, TxDay>;
  rcv: Map<string, Map<string, TxDay & { account: string; rank: number | null }>>;
  omft: Map<string, TxDay>;
}
export function collectTx(tables: Table[]): TxData {
  const out: TxData = { days: new Map(), rcv: new Map(), omft: new Map() };
  for (const t of tables)
    for (const r of rowsOf(t)) {
      const date = r.block_date as string;
      const v = { date, txs: big(r.txs), gas: big(r.conversion_gas), tokens: big(r.conversion_tokens_yocto) };
      if (r.kind === "day") {
        if (out.days.has(date)) throw new Error(`duplicate tx day ${date}`);
        out.days.set(date, v);
      } else if (r.kind === "omft") out.omft.set(date, v);
      else if (r.kind === "rcv") {
        const m = out.rcv.get(date) ?? new Map();
        m.set(r.account as string, {
          ...v,
          account: r.account as string,
          rank: r.day_rank === null ? null : Number(r.day_rank),
        });
        out.rcv.set(date, m);
      }
    }
  return out;
}

// ---- footprint (the documented contract sets) ----------------------------------------------------------------------------------

/** Wide-set rule thresholds (documented in NOTES.md): share of the Intents-origin receipt burn and dependence of the account on it. */
export const WIDE_MIN_SHARE = 0.005;
export const WIDE_MIN_DEPENDENCE = 0.5;

export interface DiscoveryDay {
  day: string;
  table: Table;
}
export interface FootprintRow {
  account: string;
  intentsTokens: bigint; // summed over the sample days (receipts that originated from transactions to intents.near)
  shareOfIntentsOrigin: string; // percent of the __all_executors__ total
  ownTokens: bigint | null; // total burn of the account on the same days (outcomes scan), null when unknown
  dependencePct: string | null; // intentsTokens / ownTokens
  inCore: boolean;
  inWide: boolean;
  reason: string;
}
export interface Footprint {
  core: string[];
  wide: string[];
  sampleDays: string[];
  originTotalTokens: bigint;
  top40Tokens: bigint;
  rows: FootprintRow[];
}

/**
 * Core = the Intents verifier contracts of the account-scan rule that burn anything in the window.
 * Wide = core plus every discovered executor that (a) carries at least WIDE_MIN_SHARE of the Intents-origin receipt burn on the
 * sample days and (b) gets at least WIDE_MIN_DEPENDENCE of its OWN burn on those days from Intents-origin receipts. (b) keeps
 * generic contracts (wrap.near, stablecoins, other apps' tokens) out: summing their whole executor burn would credit Intents with
 * other people's usage. Accounts whose own burn is unknown (below the daily rank cut) are excluded and listed.
 */
export function deriveFootprint(
  discovery: DiscoveryDay[],
  outcomes: OutcomesData,
  core: readonly string[] = INTENTS_VERIFIER_RECEIVERS,
): Footprint {
  const sampleDays = discovery.map((d) => d.day).sort();
  const acc = new Map<string, bigint>();
  let originTotal = 0n;
  for (const d of discovery)
    for (const r of rowsOf(d.table)) {
      const a = r.executor_account_id as string;
      if (a === DISCOVERY_ALL) originTotal += big(r.tokens_yocto);
      else acc.set(a, (acc.get(a) ?? 0n) + big(r.tokens_yocto));
    }
  const coreActive = core.filter((a) => {
    for (const m of outcomes.ex.values()) if ((m.get(a)?.tokens ?? 0n) > 0n) return true;
    return acc.has(a);
  });
  const rows: FootprintRow[] = [];
  let top40 = 0n;
  for (const [account, intentsTokens] of [...acc.entries()].sort((a, b) =>
    a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] > b[1] ? -1 : 1,
  )) {
    top40 += intentsTokens;
    let own: bigint | null = 0n;
    for (const day of sampleDays) {
      const row = outcomes.ex.get(day)?.get(account);
      if (!row) {
        own = null;
        break;
      }
      own += row.tokens;
    }
    const inCore = coreActive.includes(account);
    const shareOk =
      originTotal > 0n && Number((intentsTokens * 1_000_000n) / originTotal) / 1_000_000 >= WIDE_MIN_SHARE;
    const depOk =
      own !== null &&
      own > 0n &&
      Number((intentsTokens * 1_000_000n) / own) / 1_000_000 >= WIDE_MIN_DEPENDENCE;
    const inWide = inCore || (shareOk && depOk);
    rows.push({
      account,
      intentsTokens,
      shareOfIntentsOrigin: pct(intentsTokens, originTotal) ?? "n/a",
      ownTokens: own,
      dependencePct: own && own > 0n ? pct(intentsTokens, own) : null,
      inCore,
      inWide,
      reason: inCore
        ? "core Intents contract"
        : inWide
          ? "settlement footprint: share and dependence thresholds met"
          : own === null
            ? "own burn unknown (below the daily rank cut): excluded"
            : !shareOk
              ? "below the share threshold: excluded"
              : "generic contract, mostly other usage: excluded",
    });
  }
  const wide = [...new Set([...coreActive, ...rows.filter((r) => r.inWide).map((r) => r.account)])].sort();
  return {
    core: [...coreActive].sort(),
    wide,
    sampleDays,
    originTotalTokens: originTotal,
    top40Tokens: top40,
    rows,
  };
}

// ---- series ---------------------------------------------------------------------------------------------------------------------

export interface TotalRow {
  d: string;
  outcomes: string;
  gas_burnt: string;
  tokens_burnt_yocto: string;
  tokens_burnt_near: string;
  blocks: string | null;
  avg_gas_price_yocto: string | null;
  min_gas_price_yocto: string | null;
  max_gas_price_yocto: string | null;
  null_gas_rows: string;
  null_token_rows: string;
}

/** Series 1. A day without an outcome row is absent (never zero-filled); the gas price columns are null when the blocks day is absent. */
export function buildTotal(o: OutcomesData, blocks: Map<string, BlocksDay>): TotalRow[] {
  return [...o.days.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((r) => {
      const b = blocks.get(r.date);
      return {
        d: r.date,
        outcomes: r.outcomes.toString(),
        gas_burnt: r.gas.toString(),
        tokens_burnt_yocto: r.tokens.toString(),
        tokens_burnt_near: yoctoToNear(r.tokens),
        blocks: b ? b.blocks.toString() : null,
        avg_gas_price_yocto: b && b.blocks > 0n ? divDecimal(b.sum, b.blocks, 3) : null,
        min_gas_price_yocto: b ? b.min : null,
        max_gas_price_yocto: b ? b.max : null,
        null_gas_rows: r.nullGas.toString(),
        null_token_rows: r.nullTokens.toString(),
      };
    });
}

export interface IntentsRow {
  d: string;
  narrow_outcomes: string;
  narrow_gas_burnt: string;
  narrow_tokens_burnt_yocto: string;
  narrow_tokens_burnt_near: string;
  wide_outcomes: string;
  wide_gas_burnt: string;
  wide_tokens_burnt_yocto: string;
  wide_tokens_burnt_near: string;
  wide_accounts_without_row: string;
  total_tokens_burnt_yocto: string;
  narrow_share_of_total_pct: string | null;
  wide_share_of_total_pct: string | null;
}

const sumAccounts = (m: Map<string, ExRow> | undefined, accounts: readonly string[]) => {
  let n = 0n;
  let gas = 0n;
  let tokens = 0n;
  let missing = 0;
  for (const a of accounts) {
    const r = m?.get(a);
    if (!r) {
      missing++;
      continue;
    }
    n += r.n;
    gas += r.gas;
    tokens += r.tokens;
  }
  return { n, gas, tokens, missing };
};

/**
 * Series 2: per day, tokens and gas burnt by execution outcomes whose executor is a narrow (core) or wide (core + settlement
 * footprint) Intents account. A core account without a row on a day has no outcomes that day (core accounts are always kept);
 * a wide account without a row is below the daily rank cut (counted in wide_accounts_without_row, never presented as exact zero).
 */
export function buildIntents(o: OutcomesData, fp: Footprint): IntentsRow[] {
  return [...o.days.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((day) => {
      const m = o.ex.get(day.date);
      const nar = sumAccounts(m, fp.core);
      const wid = sumAccounts(m, fp.wide);
      return {
        d: day.date,
        narrow_outcomes: nar.n.toString(),
        narrow_gas_burnt: nar.gas.toString(),
        narrow_tokens_burnt_yocto: nar.tokens.toString(),
        narrow_tokens_burnt_near: yoctoToNear(nar.tokens),
        wide_outcomes: wid.n.toString(),
        wide_gas_burnt: wid.gas.toString(),
        wide_tokens_burnt_yocto: wid.tokens.toString(),
        wide_tokens_burnt_near: yoctoToNear(wid.tokens),
        wide_accounts_without_row: String(fp.wide.filter((a) => !fp.core.includes(a) && !m?.get(a)).length),
        total_tokens_burnt_yocto: day.tokens.toString(),
        narrow_share_of_total_pct: pct(nar.tokens, day.tokens),
        wide_share_of_total_pct: pct(wid.tokens, day.tokens),
      };
    });
}

export interface QuarterlyTopRow {
  scope: string;
  rank: number;
  account: string;
  outcomes: string;
  gas_burnt: string;
  tokens_burnt_yocto: string;
  tokens_burnt_near: string;
  share_of_total_pct: string | null;
  chunks_present: string;
  chunks_total: string;
  lower_bound_only: boolean;
}

export const quarterOf = (day: string): string =>
  `${day.slice(0, 4)}Q${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}`;

/**
 * Series 3: the top accounts (executors, so contracts AND signers whose transaction outcome burnt tokens) by tokens burnt for the
 * whole window and per quarter. Built from the per-chunk top lists: an account missing from a chunk's list burnt at most that
 * chunk's smallest listed amount there, so any account not present in every chunk is flagged lower_bound_only (exact otherwise).
 */
export function buildTopReceivers(o: OutcomesData, topN = 50): QuarterlyTopRow[] {
  const byChunk = new Map<string, TopRow[]>();
  for (const t of o.top) byChunk.set(t.chunk, [...(byChunk.get(t.chunk) ?? []), t]);
  const chunkQuarter = new Map(o.chunks.map((c) => [c.id, quarterOf(c.from)] as const));
  const scopes = ["window", ...new Set([...chunkQuarter.values()])].sort();
  const out: QuarterlyTopRow[] = [];
  for (const scope of scopes) {
    const ids = o.chunks
      .filter((c) => scope === "window" || chunkQuarter.get(c.id) === scope)
      .map((c) => c.id);
    const totalTokens = [...o.days.values()]
      .filter((d) => {
        const chunk = o.chunks.find((c) => d.date >= c.from && d.date < c.to);
        return chunk !== undefined && ids.includes(chunk.id);
      })
      .reduce((s, d) => s + d.tokens, 0n);
    const agg = new Map<string, { n: bigint; gas: bigint; tokens: bigint; present: number }>();
    for (const id of ids)
      for (const t of byChunk.get(id) ?? []) {
        const a = agg.get(t.account) ?? { n: 0n, gas: 0n, tokens: 0n, present: 0 };
        a.n += t.n;
        a.gas += t.gas;
        a.tokens += t.tokens;
        a.present += 1;
        agg.set(t.account, a);
      }
    [...agg.entries()]
      .sort((a, b) =>
        a[1].tokens === b[1].tokens ? (a[0] < b[0] ? -1 : 1) : a[1].tokens > b[1].tokens ? -1 : 1,
      )
      .slice(0, topN)
      .forEach(([account, a], i) =>
        out.push({
          scope,
          rank: i + 1,
          account,
          outcomes: a.n.toString(),
          gas_burnt: a.gas.toString(),
          tokens_burnt_yocto: a.tokens.toString(),
          tokens_burnt_near: yoctoToNear(a.tokens),
          share_of_total_pct: pct(a.tokens, totalTokens),
          chunks_present: String(a.present),
          chunks_total: String(ids.length),
          lower_bound_only: a.present < ids.length,
        }),
      );
  }
  return out;
}

export interface TxFeeRow {
  d: string;
  txs_total: string;
  conversion_tokens_total_yocto: string;
  narrow_txs: string;
  narrow_conversion_gas: string;
  narrow_conversion_tokens_yocto: string;
  narrow_conversion_tokens_near: string;
  wide_txs: string;
  wide_conversion_gas: string;
  wide_conversion_tokens_yocto: string;
  wide_conversion_tokens_near: string;
  narrow_receipt_outcomes: string | null;
  narrow_outcomes_per_tx: string | null;
  narrow_executor_tokens_yocto: string | null;
  narrow_direct_toll_yocto: string | null;
  narrow_conversion_share_of_direct_pct: string | null;
}

/**
 * Series 4 and the reconciliation with series 2 (days where both exist). The two are different parts of the same toll:
 *  - transactions.receipt_conversion_*: the cost of converting the signed transaction into its first receipt, charged at the
 *    transaction outcome (executor = the signer), so series 2 never contains it;
 *  - series 2: execution of receipts ON the Intents contracts (executor = the contract).
 * narrow_direct_toll = series 2 narrow tokens + conversion tokens of transactions sent to the narrow contracts;
 * narrow_outcomes_per_tx = receipt outcomes on the narrow contracts per transaction sent to them (>= 1 expected: callbacks and
 * receipts forwarded by other contracts also execute there; transactions that fail at conversion have none).
 */
export function buildTxFees(tx: TxData, intents: Map<string, IntentsRow>, fp: Footprint): TxFeeRow[] {
  return [...tx.days.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((day) => {
      const m = tx.rcv.get(day.date);
      const sum = (accounts: readonly string[]) => {
        let txs = 0n;
        let gas = 0n;
        let tokens = 0n;
        for (const a of accounts) {
          const r = m?.get(a);
          if (r) {
            txs += r.txs;
            gas += r.gas;
            tokens += r.tokens;
          }
        }
        return { txs, gas, tokens };
      };
      const nar = sum(fp.core);
      const wid = sum(fp.wide);
      const i = intents.get(day.date);
      const exec = i ? BigInt(i.narrow_tokens_burnt_yocto) : null;
      return {
        d: day.date,
        txs_total: day.txs.toString(),
        conversion_tokens_total_yocto: day.tokens.toString(),
        narrow_txs: nar.txs.toString(),
        narrow_conversion_gas: nar.gas.toString(),
        narrow_conversion_tokens_yocto: nar.tokens.toString(),
        narrow_conversion_tokens_near: yoctoToNear(nar.tokens),
        wide_txs: wid.txs.toString(),
        wide_conversion_gas: wid.gas.toString(),
        wide_conversion_tokens_yocto: wid.tokens.toString(),
        wide_conversion_tokens_near: yoctoToNear(wid.tokens),
        narrow_receipt_outcomes: i ? i.narrow_outcomes : null,
        narrow_outcomes_per_tx: i && nar.txs > 0n ? divDecimal(BigInt(i.narrow_outcomes), nar.txs, 4) : null,
        narrow_executor_tokens_yocto: exec === null ? null : exec.toString(),
        narrow_direct_toll_yocto: exec === null ? null : (exec + nar.tokens).toString(),
        narrow_conversion_share_of_direct_pct: exec === null ? null : pct(nar.tokens, exec + nar.tokens),
      };
    });
}

// ---- take rate --------------------------------------------------------------------------------------------------------------------

export interface TakeRateRow {
  d: string;
  price_usd: string | null;
  volume_usd: string | null;
  narrow_burn_usd: string | null;
  wide_burn_usd: string | null;
  take_rate_gas_bps_narrow: string | null;
  take_rate_gas_bps_wide: string | null;
  take_rate_gas_bps_narrow_30d: string | null;
  take_rate_gas_bps_wide_30d: string | null;
  days_in_30d: string;
  intents_share_of_burn_pct_narrow: string | null;
  intents_share_of_burn_pct_wide: string | null;
}

export const TAKE_RATE_WINDOW_DAYS = 30;
export const TAKE_RATE_MIN_DAYS = 15;

/**
 * Take rate (gas / burn toll only): NEAR burnt by Intents contracts x that day's NEAR/USD close / that day's Intents successful
 * known-USD volume, in basis points of settled value. Null when the price or volume of the day is absent (never zero). The 30-day
 * figure is a ratio of sums (sum of burn USD / sum of volume USD) over the trailing 30 calendar days, on days where the burn, the
 * price and the volume all exist; null with fewer than TAKE_RATE_MIN_DAYS such days. NOT the whole cost of using NEAR: it is the
 * protocol-level burn of the outcomes executed on the Intents contracts only (not conversion burn, not other contracts, not the
 * value users pay to relayers or solvers).
 */
export function buildTakeRate(
  intents: IntentsRow[],
  price: Map<string, string | null>,
  volume: Map<string, string | null>,
): TakeRateRow[] {
  const rows: TakeRateRow[] = [];
  const usable: Array<{ d: string; nar: bigint; wid: bigint; vol: Dec; priceDec: Dec } | null> = [];
  for (const r of intents) {
    const p = price.get(r.d) ?? null;
    const v = volume.get(r.d) ?? null;
    const narY = BigInt(r.narrow_tokens_burnt_yocto);
    const widY = BigInt(r.wide_tokens_burnt_yocto);
    usable.push(
      p && v && parseDec(v).n > 0n
        ? { d: r.d, nar: narY, wid: widY, vol: parseDec(v), priceDec: parseDec(p) }
        : null,
    );
    rows.push({
      d: r.d,
      price_usd: p,
      volume_usd: v,
      narrow_burn_usd: p ? usdOf(narY, p) : null,
      wide_burn_usd: p ? usdOf(widY, p) : null,
      take_rate_gas_bps_narrow: p && v ? takeRateBps(narY, p, v) : null,
      take_rate_gas_bps_wide: p && v ? takeRateBps(widY, p, v) : null,
      take_rate_gas_bps_narrow_30d: null,
      take_rate_gas_bps_wide_30d: null,
      days_in_30d: "0",
      intents_share_of_burn_pct_narrow: r.narrow_share_of_total_pct,
      intents_share_of_burn_pct_wide: r.wide_share_of_total_pct,
    });
  }
  const byDay = new Map(usable.filter((u) => u !== null).map((u) => [u.d, u] as const));
  for (const row of rows) {
    const start = addDays(row.d, -(TAKE_RATE_WINDOW_DAYS - 1));
    let nUsed = 0;
    // exact common denominator: burn_yocto x price_int / 10^(24+ps) over vol_int / 10^vs, each term scaled by 10^30
    let burnNarScaled = 0n;
    let burnWidScaled = 0n;
    let volScaled = 0n;
    for (let d = start; d <= row.d; d = addDays(d, 1)) {
      const u = byDay.get(d);
      if (!u) continue;
      nUsed++;
      const S = 10n ** 30n;
      // USD = yocto x pn / 10^(24+ps); volume USD = vn / 10^vs; both multiplied by S to stay integral
      burnNarScaled += (u.nar * u.priceDec.n * S) / (YOCTO * 10n ** BigInt(u.priceDec.scale));
      burnWidScaled += (u.wid * u.priceDec.n * S) / (YOCTO * 10n ** BigInt(u.priceDec.scale));
      volScaled += (u.vol.n * S) / 10n ** BigInt(u.vol.scale);
    }
    row.days_in_30d = String(nUsed);
    if (nUsed >= TAKE_RATE_MIN_DAYS && volScaled > 0n) {
      row.take_rate_gas_bps_narrow_30d = divDecimal(burnNarScaled * 10_000n, volScaled, 8);
      row.take_rate_gas_bps_wide_30d = divDecimal(burnWidScaled * 10_000n, volScaled, 8);
    }
  }
  return rows;
}

// ---- cross-check against the local near_economics tables --------------------------------------------------------------------------

export interface DailyTotals {
  tokens: bigint;
  gas: bigint;
}
export interface CrossCheck {
  matchingDays: number;
  onlyMineDays: number;
  onlyTheirsDays: number;
  tokens: {
    maxAbsDiffYocto: string;
    maxAbsDiffDay: string | null;
    maxRelDiff: string | null;
    identicalDays: number;
  };
  gas: { maxAbsDiff: string; maxAbsDiffDay: string | null; maxRelDiff: string | null; identicalDays: number };
  worst: Array<{
    d: string;
    mineTokens: string;
    theirsTokens: string;
    absDiff: string;
    relDiff: string | null;
  }>;
}

/** Exact comparison of daily totals on the days both exist. relDiff = |mine - theirs| / theirs (decimal, 12 places). */
export function crossCheck(mine: Map<string, DailyTotals>, theirs: Map<string, DailyTotals>): CrossCheck {
  const days = [...mine.keys()].filter((d) => theirs.has(d)).sort();
  const abs = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);
  const rel = (a: bigint, b: bigint): string | null => (b === 0n ? null : divDecimal(abs(a, b), b, 12));
  let tokMax = 0n;
  let tokDay: string | null = null;
  let tokRelMax = 0n;
  let tokRel: string | null = null;
  let tokSame = 0;
  let gasMax = 0n;
  let gasDay: string | null = null;
  let gasRelMax = 0n;
  let gasRel: string | null = null;
  let gasSame = 0;
  const diffs: CrossCheck["worst"] = [];
  for (const d of days) {
    const a = mine.get(d) as DailyTotals;
    const b = theirs.get(d) as DailyTotals;
    const dt = abs(a.tokens, b.tokens);
    const dg = abs(a.gas, b.gas);
    if (dt === 0n) tokSame++;
    if (dg === 0n) gasSame++;
    if (dt > tokMax) {
      tokMax = dt;
      tokDay = d;
    }
    if (dg > gasMax) {
      gasMax = dg;
      gasDay = d;
    }
    if (b.tokens > 0n) {
      const r = (dt * 10n ** 12n) / b.tokens;
      if (r > tokRelMax) {
        tokRelMax = r;
        tokRel = rel(a.tokens, b.tokens);
      }
    }
    if (b.gas > 0n) {
      const r = (dg * 10n ** 12n) / b.gas;
      if (r > gasRelMax) {
        gasRelMax = r;
        gasRel = rel(a.gas, b.gas);
      }
    }
    diffs.push({
      d,
      mineTokens: a.tokens.toString(),
      theirsTokens: b.tokens.toString(),
      absDiff: dt.toString(),
      relDiff: rel(a.tokens, b.tokens),
    });
  }
  diffs.sort((x, y) =>
    BigInt(y.absDiff) > BigInt(x.absDiff) ? 1 : BigInt(y.absDiff) < BigInt(x.absDiff) ? -1 : 0,
  );
  return {
    matchingDays: days.length,
    onlyMineDays: [...mine.keys()].filter((d) => !theirs.has(d)).length,
    onlyTheirsDays: [...theirs.keys()].filter((d) => !mine.has(d)).length,
    tokens: {
      maxAbsDiffYocto: tokMax.toString(),
      maxAbsDiffDay: tokDay,
      maxRelDiff: tokRel ?? (days.length ? "0.000000000000" : null),
      identicalDays: tokSame,
    },
    gas: {
      maxAbsDiff: gasMax.toString(),
      maxAbsDiffDay: gasDay,
      maxRelDiff: gasRel ?? (days.length ? "0.000000000000" : null),
      identicalDays: gasSame,
    },
    worst: diffs.slice(0, 5),
  };
}

// ---- headline ---------------------------------------------------------------------------------------------------------------------

export interface HeadlinePeriod {
  from: string;
  to: string;
  daysWithBurn: number;
  totalBurnNearPerDay: string | null;
  totalBurnUsdPerDay: string | null;
  intentsNarrowNearPerDay: string | null;
  intentsWideNearPerDay: string | null;
  narrowSharePct: string | null;
  wideSharePct: string | null;
  takeRateBpsNarrow: string | null;
  takeRateBpsWide: string | null;
  takeRateDays: number;
}

/**
 * First and last 30 days of the data: per-day averages over the days that have a burn row (NEAR exact, USD at each day's own close),
 * shares as ratios of sums, take rate as sum of burn USD over sum of volume USD on days where the burn, price and volume all exist.
 */
export function headline(
  total: TotalRow[],
  intents: IntentsRow[],
  price: Map<string, string | null>,
  volume: Map<string, string | null>,
  which: "first" | "last",
  days = 30,
): HeadlinePeriod {
  const ds = total.map((t) => t.d).sort();
  const pick = which === "first" ? ds.slice(0, days) : ds.slice(-days);
  const set = new Set(pick);
  const tot = total.filter((t) => set.has(t.d));
  const int = new Map(intents.filter((t) => set.has(t.d)).map((t) => [t.d, t] as const));
  const n = BigInt(tot.length);
  let totY = 0n;
  let narY = 0n;
  let widY = 0n;
  let usdTotalScaled = 0n;
  let tNar = 0n;
  let tWid = 0n;
  let tVol = 0n;
  let tDays = 0;
  const S = 10n ** 30n;
  for (const t of tot) {
    const y = BigInt(t.tokens_burnt_yocto);
    totY += y;
    const i = int.get(t.d);
    if (i) {
      narY += BigInt(i.narrow_tokens_burnt_yocto);
      widY += BigInt(i.wide_tokens_burnt_yocto);
    }
    const p = price.get(t.d);
    if (p) {
      const pd = parseDec(p);
      usdTotalScaled += (y * pd.n * S) / (YOCTO * 10n ** BigInt(pd.scale));
      const v = volume.get(t.d);
      if (i && v && parseDec(v).n > 0n) {
        const vd = parseDec(v);
        tNar += (BigInt(i.narrow_tokens_burnt_yocto) * pd.n * S) / (YOCTO * 10n ** BigInt(pd.scale));
        tWid += (BigInt(i.wide_tokens_burnt_yocto) * pd.n * S) / (YOCTO * 10n ** BigInt(pd.scale));
        tVol += (vd.n * S) / 10n ** BigInt(vd.scale);
        tDays++;
      }
    }
  }
  const perDayNear = (y: bigint): string | null => (n === 0n ? null : divDecimal(y, n * YOCTO, 4));
  return {
    from: pick[0] ?? "",
    to: pick[pick.length - 1] ?? "",
    daysWithBurn: tot.length,
    totalBurnNearPerDay: perDayNear(totY),
    totalBurnUsdPerDay: n === 0n ? null : divDecimal(usdTotalScaled, n * S, 2),
    intentsNarrowNearPerDay: perDayNear(narY),
    intentsWideNearPerDay: perDayNear(widY),
    narrowSharePct: pct(narY, totY, 4),
    wideSharePct: pct(widY, totY, 4),
    takeRateBpsNarrow: tVol > 0n ? divDecimal(tNar * 10_000n, tVol, 4) : null,
    takeRateBpsWide: tVol > 0n ? divDecimal(tWid * 10_000n, tVol, 4) : null,
    takeRateDays: tDays,
  };
}
