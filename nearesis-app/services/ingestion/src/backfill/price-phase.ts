import type { ClickHouseClient } from "@clickhouse/client";
import type { RawArchive } from "../archive/archive.ts";
import { IngestionError } from "../errors.ts";
import { ALLOW_COINGECKO_PUBLIC, HttpClient } from "../http/client.ts";
import type { CredentialSource } from "../http/credentials.ts";
import {
  aggregateToDaily,
  buildPriceRows,
  eachDay,
  PRICE_ADAPTER_VERSION,
  parseJsonLossless,
  plainNumber,
  type RawCandle,
} from "../adapters/price.ts";
import { coverageRows, insertLive, priceRows } from "./ch.ts";
import { addDays, WINDOW_FROM, WINDOW_TO } from "./plan.ts";
import type { StateStore } from "./state.ts";

const HOUR = 3_600_000;
const SPAN_DAYS = 89; // CoinGecko serves hourly points for ranges of at most 90 days
export const PRICE_BASIS = "hourly_samples_24_per_day";

/** Hourly CoinGecko price points -> exact-text candles with open = high = low = close = the sampled price. */
export function parseHourlyPoints(body: Uint8Array): RawCandle[] {
  const j = parseJsonLossless(new TextDecoder().decode(body)) as { prices?: unknown };
  if (!Array.isArray(j.prices))
    throw new IngestionError("INVALID_INPUT", false, { reason: "no prices array" });
  return j.prices.map((p) => {
    const t = Array.isArray(p) ? (p[0] as { __num?: string } | undefined) : undefined;
    const v = Array.isArray(p) ? (p[1] as { __num?: string } | undefined) : undefined;
    if (!t?.__num || !v?.__num)
      throw new IngestionError("INVALID_INPUT", false, { reason: "bad price point" });
    const price = plainNumber(v.__num);
    return { tsMs: Number(t.__num), open: price, high: price, low: price, close: price };
  });
}

/** Whole-UTC-day windows [from, from+span) so every day lies inside exactly one request. */
export function priceWindows(
  from: string,
  to: string,
  spanDays = SPAN_DAYS,
): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  const end = addDays(to, 1);
  for (let cur = from; cur < end;) {
    const upper = addDays(cur, spanDays) < end ? addDays(cur, spanDays) : end;
    out.push({ from: cur, to: upper });
    cur = upper;
  }
  return out;
}

/** One request window of hourly points -> the exact-text daily candle file the price builder consumes. */
export function dailyFileBytes(
  body: Uint8Array,
  w: { from: string; to: string },
): { dedupCount: number; dailyCount: number; bytes: Uint8Array; days: string[] } {
  const fromMs = Date.parse(`${w.from}T00:00:00Z`);
  const toMs = Date.parse(`${w.to}T00:00:00Z`);
  const inWindow = parseHourlyPoints(body).filter((c) => c.tsMs >= fromMs && c.tsMs < toMs);
  const dedup = [...new Map(inWindow.map((c) => [c.tsMs, c])).values()];
  const daily = aggregateToDaily(dedup, HOUR); // only days with all 24 samples; the rest stay gaps
  const bytes = new TextEncoder().encode(
    `[${daily.map((c) => `[${c.tsMs},${c.open},${c.high},${c.low},${c.close}]`).join(",")}]`,
  );
  return {
    dedupCount: dedup.length,
    dailyCount: daily.length,
    bytes,
    days: daily.map((c) => new Date(c.tsMs).toISOString().slice(0, 10)),
  };
}

/** Builds and loads price candles, coverage and gaps from the per-window fetches. Idempotent (ReplacingMergeTree). */
export async function loadPriceFetches(
  ch: ClickHouseClient,
  fetches: Parameters<typeof buildPriceRows>[1],
  version: number,
  window: { from: string; to: string } = { from: WINDOW_FROM, to: WINDOW_TO },
): Promise<{ days: number; gaps: number; from: string | null; to: string | null }> {
  const cfg = {
    coinId: "near",
    symbol: "NEAR",
    quoteCurrency: "usd",
    window,
  };
  const built = buildPriceRows(cfg, fetches);
  await insertLive(ch, "price_candles", priceRows(built.rows, PRICE_BASIS));
  const have = new Set(built.rows.map((r) => r.bucketStartUTC.slice(0, 10)));
  await insertLive(
    ch,
    "source_coverage",
    coverageRows(
      eachDay(window.from, window.to).map((day) => ({
        provider_id: "coingecko",
        dataset: "price_candles",
        day,
        state: have.has(day) ? ("complete" as const) : ("unavailable" as const),
        reason: have.has(day) ? null : "PROVIDER_GAP",
        version,
      })),
    ),
  );
  await insertLive(
    ch,
    "quality_gaps",
    built.gaps.map((g) => ({
      provider_id: "coingecko",
      dataset: "price_candles",
      from_utc: `${g.day}T00:00:00.000Z`,
      to_utc: `${g.day}T23:59:59.999Z`,
      state: "unavailable",
      reason_code: g.reason,
      source_label: "LIVE",
      version,
    })),
  );
  const days = [...have].sort();
  return { days: built.rows.length, gaps: built.gaps.length, from: days[0] ?? null, to: days.at(-1) ?? null };
}

export interface PriceResult {
  skipped: boolean;
  requests: number;
  days: number;
  gaps: number;
  from: string | null;
  to: string | null;
  authMode: string;
}

export async function runPricePhase(d: {
  ch: ClickHouseClient;
  archive: RawArchive;
  creds: CredentialSource;
  store: StateStore;
  log: (m: string) => void;
  fetchImpl?: ConstructorParameters<typeof HttpClient>[0]["fetchImpl"];
  sleepMs?: number;
}): Promise<PriceResult> {
  if (d.store.state.price?.done)
    return {
      skipped: true,
      requests: d.store.state.price.requests,
      days: d.store.state.price.days,
      gaps: 0,
      from: null,
      to: null,
      authMode: "n/a",
    };
  const hasKey = d.creds.has("COINGECKO_API_KEY");
  const http = new HttpClient({
    allow: [ALLOW_COINGECKO_PUBLIC],
    credentials: d.creds,
    ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}),
  });
  const fetches: Parameters<typeof buildPriceRows>[1] = [];
  for (const w of priceWindows(WINDOW_FROM, WINDOW_TO)) {
    const url = `https://api.coingecko.com/api/v3/coins/near/market_chart/range?vs_currency=usd&from=${Date.parse(`${w.from}T00:00:00Z`) / 1000}&to=${Date.parse(`${w.to}T00:00:00Z`) / 1000}`;
    const res = await http.request({
      method: "GET",
      url,
      ...(hasKey
        ? { auth: { credential: "COINGECKO_API_KEY", header: "x-cg-demo-api-key", scheme: "" as const } }
        : {}),
    });
    if (res.status !== 200)
      throw new IngestionError("AUTH_REJECTED", false, {
        reason: "coingecko non-200",
        status: res.status,
        window: w,
      });
    const fetchedAtUTC = new Date(res.receivedAtMs).toISOString();
    const a = await d.archive.archive({
      providerId: "coingecko",
      adapterVersion: PRICE_ADAPTER_VERSION,
      method: "GET",
      url,
      sourceEnvironment: "live",
      fetchedAtUTC,
      receivedAtUTC: fetchedAtUTC,
      providerEventAtUTC: null,
      providerEventAtNullReason: "range of hourly price points; no single event time",
      responseStatus: 200,
      contentType: "application/json",
      payload: res.body,
      privacyVisibility: "public",
      completeness: "complete",
    });
    const { dedupCount, dailyCount, bytes } = dailyFileBytes(res.body, w);
    fetches.push({
      fileBytes: bytes,
      fetchedAtUTC,
      rawObjectHash: a.observation.payloadObjectHash,
      sourceLabel: "LIVE",
    });
    d.log(`price window ${w.from}..${w.to}: ${dedupCount} hourly points, ${dailyCount} complete days`);
    await new Promise((r) => setTimeout(r, d.sleepMs ?? 2500));
  }
  const loaded = await loadPriceFetches(d.ch, fetches, Date.now());
  const days = loaded.days;
  d.store.state.price = { done: true, requests: http.requestLog.length, days };
  d.store.save();
  return {
    skipped: false,
    requests: http.requestLog.length,
    days,
    gaps: loaded.gaps,
    from: loaded.from,
    to: loaded.to,
    authMode: hasKey ? "x-cg-demo-api-key on api.coingecko.com" : "none (public)",
  };
}
