import { addDays, round } from "./forecast.ts";
import { columnMap } from "./forecast-inputs.ts";
import type { ForecastInputs } from "./forecast-inputs.ts";

/** Numbers computed from the frozen raw files (no model, no clock). They are written into raw/forecast.json under `facts`. */
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const rng = (m: Map<string, number | null>, from: string, to: string): number[] => {
  const out: number[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = m.get(d);
    if (v !== null && v !== undefined) out.push(v);
  }
  return out;
};

export function computeFacts(inp: ForecastInputs): Record<string, unknown> {
  const R = (id: string) => inp.raw.get(id)!;
  const tx = (c: string) => columnMap(R("transactions_daily"), c);
  const tail = (c: string) => columnMap(R("tail_daily"), c);
  const intentsTx = columnMap(R("intents_tx_daily"), "value");
  const usd = columnMap(R("intents_volume_daily"), "value");
  const med = columnMap(R("swaps_daily"), "median_usd");
  const cnt = columnMap(R("swaps_daily"), "success_swaps");
  const mixCol = (c: string) => columnMap(R("intents_mix_daily"), c);
  const price = columnMap(R("near_price_daily"), "value");
  const newS = columnMap(R("new_signers_daily"), "value");
  const days = inp.days;

  // ---- monthly table -------------------------------------------------------------------------------------------------------
  const months = [...new Set(days.map((d) => d.slice(0, 7)))];
  const monthly = months.map((mo) => {
    const ds = days.filter((d) => d.startsWith(mo));
    const a = ds[0]!;
    const b = ds[ds.length - 1]!;
    const avg = (m: Map<string, number | null>): number | null => {
      const v = mean(rng(m, a, b));
      return v === null ? null : round(v, 4);
    };
    const total = sum(rng(mixCol("total_usd"), a, b));
    const share = (c: string): number | null =>
      total > 0 ? round(sum(rng(mixCol(c), a, b)) / total, 6) : null;
    return {
      month: mo,
      firstDay: a,
      lastDay: b,
      days: ds.length,
      intents_tx: avg(intentsTx),
      tail_tx: avg(tail("tail_tx")),
      tail_signers: avg(tail("tail_signers")),
      tx_total: avg(tx("tx_total")),
      new_signers: avg(newS),
      intents_usd: avg(usd),
      swaps: avg(cnt),
      median_swap_usd: avg(med),
      stable_share: share("stable_usd"),
      no_near_share: share("no_near_usd"),
      near_token_share: share("near_token_usd"),
      usdDays: rng(usd, a, b).length,
    };
  });

  // ---- the 2026-04-02 break ---------------------------------------------------------------------------------------------
  const BD = "2026-04-02";
  const prev = addDays(BD, -1);
  const g = (m: Map<string, number | null>, d: string): number => m.get(d) as number;
  const pct = (a: number, b: number): number => round((b - a) / a, 6);
  const brk = {
    day: BD,
    previousDay: prev,
    totalPrev: g(tx("tx_total"), prev),
    totalDay: g(tx("tx_total"), BD),
    totalChange: pct(g(tx("tx_total"), prev), g(tx("tx_total"), BD)),
    headPrev: g(tx("tx_head"), prev),
    headDay: g(tx("tx_head"), BD),
    headChange: pct(g(tx("tx_head"), prev), g(tx("tx_head"), BD)),
    tailTxPrev: g(tail("tail_tx"), prev),
    tailTxDay: g(tail("tail_tx"), BD),
    tailTxChange: pct(g(tail("tail_tx"), prev), g(tail("tail_tx"), BD)),
    tailSignersPrev: g(tail("tail_signers"), prev),
    tailSignersDay: g(tail("tail_signers"), BD),
    tailSignersChange: pct(g(tail("tail_signers"), prev), g(tail("tail_signers"), BD)),
    tailTx7Before: round(mean(rng(tail("tail_tx"), addDays(BD, -7), prev))!, 2),
    tailTx7After: round(mean(rng(tail("tail_tx"), BD, addDays(BD, 6)))!, 2),
    tailSigners7Before: round(mean(rng(tail("tail_signers"), addDays(BD, -7), prev))!, 2),
    tailSigners7After: round(mean(rng(tail("tail_signers"), BD, addDays(BD, 6)))!, 2),
  };

  // ---- composition and the May 2026 excursion --------------------------------------------------------------------------
  const nt = mixCol("near_token_share");
  const ntUsd = mixCol("near_token_usd");
  let peak: { d: string; v: number } = { d: "", v: -1 };
  for (const d of days) {
    const v = nt.get(d);
    if (v !== null && v !== undefined && v > peak.v) peak = { d, v };
  }
  const exFrom = "2026-05-22";
  const exTo = "2026-05-27";
  const exNear = sum(rng(ntUsd, exFrom, exTo));
  const routes = R("excursion_routes").rows;
  const top = routes[0]!;
  const top2 = routes[1]!;
  const excursion = {
    from: exFrom,
    to: exTo,
    peakDay: peak.d,
    peakShare: round(peak.v, 6),
    nearLegUsdInWindow: round(exNear, 2),
    topRoute: `${top[0]} (${top[1]}) to ${top[2]} (${top[3]})`,
    topRouteUsd: Number(top[5]),
    topRouteSwaps: Number(top[4]),
    topRouteMedianUsd: Number(top[6]),
    topRouteShareOfNearLeg: round(Number(top[5]) / exNear, 6),
    secondRoute: `${top2[0]} (${top2[1]}) to ${top2[2]} (${top2[3]})`,
    secondRouteUsd: Number(top2[5]),
    secondRouteSharesOfNearLeg: round(Number(top2[5]) / exNear, 6),
    twoRoutesShareOfNearLeg: round((Number(top[5]) + Number(top2[5])) / exNear, 6),
    mayShare: monthly.find((m) => m.month === "2026-05")!.near_token_share,
    mayNoNear: monthly.find((m) => m.month === "2026-05")!.no_near_share,
    juneShare: monthly.find((m) => m.month === "2026-06")!.near_token_share,
  };

  // ---- chain pairs -----------------------------------------------------------------------------------------------------------
  const pr = R("chain_pairs_monthly");
  const tot = new Map<string, number>();
  for (const r of pr.rows) tot.set(`${r[1]} to ${r[2]}`, (tot.get(`${r[1]} to ${r[2]}`) ?? 0) + Number(r[3]));
  const listed = sum([...tot.values()]);
  const pairs = [...tot.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([pair, v]) => ({ pair, usd: round(v, 2), shareOfListed: round(v / listed, 6) }));
  const windowUsd = sum(rng(mixCol("total_usd"), days[0]!, days[days.length - 1]!));

  // ---- price and trade size -----------------------------------------------------------------------------------------------
  const pv = rng(price, days[0]!, days[days.length - 1]!);
  const first30 = (m: Map<string, number | null>): number =>
    round(mean(rng(m, days[0]!, addDays(days[0]!, 29)))!, 4);
  const last30 = (m: Map<string, number | null>): number =>
    round(mean(rng(m, addDays(days[days.length - 1]!, -29), days[days.length - 1]!))!, 4);
  const facts = {
    monthly,
    break: brk,
    excursion,
    chainPairs: {
      listedUsd: round(listed, 2),
      windowUsd: round(windowUsd, 2),
      shareListedOfWindow: round(listed / windowUsd, 6),
      pairs,
    },
    price: {
      first: pv[0]!,
      last: pv[pv.length - 1]!,
      change: pct(pv[0]!, pv[pv.length - 1]!),
      lastDay: days[days.length - 1]!,
    },
    tradeSize: {
      medianFirst30: first30(med),
      medianLast30: last30(med),
      swapsFirst30: first30(cnt),
      swapsLast30: last30(cnt),
    },
    last: {
      day: days[days.length - 1]!,
      intents_tx: g(intentsTx, days[days.length - 1]!),
      tail_tx: g(tail("tail_tx"), days[days.length - 1]!),
      tail_signers: g(tail("tail_signers"), days[days.length - 1]!),
    },
  };
  return facts;
}
