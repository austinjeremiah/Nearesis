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
  const cfg = {
    coinId: "near",
    symbol: "NEAR",
    quoteCurrency: "usd",
    window: { from: WINDOW_FROM, to: WINDOW_TO },
  };
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
    const fromMs = Date.parse(`${w.from}T00:00:00Z`);
    const toMs = Date.parse(`${w.to}T00:00:00Z`);
    const inWindow = parseHourlyPoints(res.body).filter((c) => c.tsMs >= fromMs && c.tsMs < toMs);
    const dedup = [...new Map(inWindow.map((c) => [c.tsMs, c])).values()];
    const daily = aggregateToDaily(dedup, HOUR); // only days with all 24 samples; the rest stay gaps
    const bytes = new TextEncoder().encode(
      `[${daily.map((c) => `[${c.tsMs},${c.open},${c.high},${c.low},${c.close}]`).join(",")}]`,
    );
    fetches.push({
      fileBytes: bytes,
      fetchedAtUTC,
      rawObjectHash: a.observation.payloadObjectHash,
      sourceLabel: "LIVE",
    });
    d.log(`price window ${w.from}..${w.to}: ${dedup.length} hourly points, ${daily.length} complete days`);
    await new Promise((r) => setTimeout(r, d.sleepMs ?? 2500));
  }
  const built = buildPriceRows(cfg, fetches);
  await insertLive(d.ch, "price_candles", priceRows(built.rows, PRICE_BASIS));
  const have = new Set(built.rows.map((r) => r.bucketStartUTC.slice(0, 10)));
  const v = Date.now();
  await insertLive(
    d.ch,
    "source_coverage",
    coverageRows(
      eachDay(WINDOW_FROM, WINDOW_TO).map((day) => ({
        provider_id: "coingecko",
        dataset: "price_candles",
        day,
        state: have.has(day) ? ("complete" as const) : ("unavailable" as const),
        reason: have.has(day) ? null : "PROVIDER_GAP",
        version: v,
      })),
    ),
  );
  await insertLive(
    d.ch,
    "quality_gaps",
    built.gaps.map((g) => ({
      provider_id: "coingecko",
      dataset: "price_candles",
      from_utc: `${g.day}T00:00:00.000Z`,
      to_utc: `${g.day}T23:59:59.999Z`,
      state: "unavailable",
      reason_code: g.reason,
      source_label: "LIVE",
      version: v,
    })),
  );
  const days = built.rows.length;
  d.store.state.price = { done: true, requests: http.requestLog.length, days };
  d.store.save();
  return {
    skipped: false,
    requests: http.requestLog.length,
    days,
    gaps: built.gaps.length,
    from: [...have].sort()[0] ?? null,
    to: [...have].sort().at(-1) ?? null,
    authMode: hasKey ? "x-cg-demo-api-key on api.coingecko.com" : "none (public)",
  };
}
