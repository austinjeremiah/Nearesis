import type { PriceCandleRow } from "./../normalized/types.ts";
import { cmpDec, divDec, formatDec, mulDec, parseDec } from "../decimal.ts";
import { sha256Hex } from "../hash.ts";
import { IngestionError } from "../errors.ts";

export const PRICE_ADAPTER_VERSION = "coingecko-price-1.0.0";

/** Parses JSON keeping every number as its exact source text (no float round-trip). */
export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, ((_k: string, v: unknown, ctx?: { source?: string }) =>
    typeof v === "number" && ctx?.source !== undefined ? { __num: ctx.source } : v) as never) as unknown;
}

const isNum = (v: unknown): v is { __num: string } => typeof v === "object" && v !== null && "__num" in v;

/** Expand a JSON number literal (may use an exponent) to plain decimal notation, exactly. */
export function plainNumber(src: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(src);
  if (!m) throw new IngestionError("INVALID_INPUT", false, { reason: "bad number literal" });
  const [, sign, ip, fp = "", exp = "0"] = m;
  let digits = `${ip}${fp}`;
  let scale = fp.length - Number(exp);
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  const padded = digits.padStart(scale + 1, "0");
  const body =
    scale === 0 ? padded : `${padded.slice(0, padded.length - scale)}.${padded.slice(padded.length - scale)}`;
  const cleaned = body
    .replace(/^0+(?=\d)/, "")
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  return cleaned === "0" ? "0" : `${sign}${cleaned}`;
}

export interface RawCandle {
  tsMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
}

export function parseOhlc(body: Uint8Array): RawCandle[] {
  const j = parseJsonLossless(new TextDecoder().decode(body));
  if (!Array.isArray(j))
    throw new IngestionError("INVALID_INPUT", false, { reason: "ohlc payload is not an array" });
  return j.map((row) => {
    if (!Array.isArray(row) || row.length < 5 || !row.every(isNum))
      throw new IngestionError("INVALID_INPUT", false, { reason: "bad ohlc row" });
    const [t, o, h, l, c] = (row as Array<{ __num: string }>).map((x) => x.__num) as [
      string,
      string,
      string,
      string,
      string,
    ];
    return {
      tsMs: Number(t),
      open: plainNumber(o),
      high: plainNumber(h),
      low: plainNumber(l),
      close: plainNumber(c),
    };
  });
}

/** Optional volumes: CoinGecko market_chart/range `total_volumes: [[ts, vol], ...]`. Keyed by tsMs. */
export function parseVolumes(body: Uint8Array): Map<number, string> {
  const j = parseJsonLossless(new TextDecoder().decode(body)) as { total_volumes?: unknown[] };
  const m = new Map<number, string>();
  for (const row of j.total_volumes ?? []) {
    if (Array.isArray(row) && isNum(row[0]) && isNum(row[1]))
      m.set(Number(row[0].__num), plainNumber(row[1].__num));
  }
  return m;
}

const DAY_MS = 86_400_000;
export const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const isDailyAligned = (ms: number): boolean => ms % DAY_MS === 0;

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS)
    out.push(isoDay(t));
  return out;
}

/** Build UTC-day candles from sub-daily candles (live probe path). Only days fully covered are produced. */
export function aggregateToDaily(candles: RawCandle[], stepMs: number): RawCandle[] {
  const per = DAY_MS / stepMs;
  const byDay = new Map<string, RawCandle[]>();
  for (const c of [...candles].sort((a, b) => a.tsMs - b.tsMs))
    byDay.set(isoDay(c.tsMs), [...(byDay.get(isoDay(c.tsMs)) ?? []), c]);
  const out: RawCandle[] = [];
  for (const [day, cs] of byDay) {
    if (cs.length < per) continue; // incomplete day stays a gap
    const num = (s: string) => parseDec(s);
    let hi = num(cs[0]!.high);
    let lo = num(cs[0]!.low);
    for (const c of cs) {
      if (cmpDec(num(c.high), hi) > 0) hi = num(c.high);
      if (cmpDec(num(c.low), lo) < 0) lo = num(c.low);
    }
    out.push({
      tsMs: Date.parse(`${day}T00:00:00Z`),
      open: cs[0]!.open,
      high: formatDec(hi),
      low: formatDec(lo),
      close: cs[cs.length - 1]!.close,
    });
  }
  return out;
}

export interface PriceFetchInput {
  fileBytes: Uint8Array;
  volumeBytes?: Uint8Array;
  fetchedAtUTC: string;
  rawObjectHash: string;
  sourceLabel: PriceCandleRow["sourceLabel"];
}
export interface PriceConfig {
  coinId: string;
  symbol: string;
  quoteCurrency: string;
  window: { from: string; to: string };
}
export interface PriceGap {
  day: string;
  reason: "PROVIDER_GAP";
}

/** Turns fetched candle payloads into rows. Out-of-window candles are never attributed to the window. */
export function buildPriceRows(
  cfg: PriceConfig,
  fetches: PriceFetchInput[],
): {
  rows: PriceCandleRow[];
  gaps: PriceGap[];
  outOfWindow: Array<{ day: string; rawObjectHash: string }>;
  warnings: string[];
} {
  const rows: PriceCandleRow[] = [];
  const outOfWindow: Array<{ day: string; rawObjectHash: string }> = [];
  const warnings: string[] = [];
  const have = new Set<string>();
  for (const f of fetches) {
    const volumes = f.volumeBytes ? parseVolumes(f.volumeBytes) : new Map<number, string>();
    for (const c of parseOhlc(f.fileBytes)) {
      if (!isDailyAligned(c.tsMs)) {
        warnings.push(`non-daily candle ignored at ${new Date(c.tsMs).toISOString()}`);
        continue;
      }
      const day = isoDay(c.tsMs);
      if (day < cfg.window.from || day > cfg.window.to) {
        outOfWindow.push({ day, rawObjectHash: f.rawObjectHash });
        continue;
      }
      have.add(day);
      rows.push({
        provider: "coingecko",
        coinId: cfg.coinId,
        symbol: cfg.symbol,
        quoteCurrency: cfg.quoteCurrency,
        interval: "1d",
        bucketStartUTC: `${day}T00:00:00.000Z`,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: volumes.get(c.tsMs) ?? null,
        providerTimestampUTC: new Date(c.tsMs).toISOString(),
        fetchedAtUTC: f.fetchedAtUTC,
        updateVintage: f.fetchedAtUTC,
        sourceLabel: f.sourceLabel,
        rawObjectHash: f.rawObjectHash,
        version: Date.parse(f.fetchedAtUTC),
      });
    }
  }
  rows.sort((a, b) => (a.bucketStartUTC + a.updateVintage).localeCompare(b.bucketStartUTC + b.updateVintage));
  const gaps = eachDay(cfg.window.from, cfg.window.to)
    .filter((d) => !have.has(d))
    .map((day) => ({ day, reason: "PROVIDER_GAP" as const }));
  return { rows, gaps, outOfWindow, warnings };
}

export type Conversion =
  | { ok: true; usd: string; day: string; vintage: string; basis: "close"; sourceHash: string }
  | { ok: false; code: "PRICE_UNAVAILABLE"; day: string; reason: string; retryable: false };

/** Conversion helper. Uses exactly the requested day's latest-vintage close; never a neighbouring day. */
export class PriceBook {
  private readonly byDay = new Map<string, PriceCandleRow[]>();
  constructor(rows: PriceCandleRow[]) {
    for (const r of rows) {
      const d = r.bucketStartUTC.slice(0, 10);
      this.byDay.set(d, [...(this.byDay.get(d) ?? []), r]);
    }
  }
  latest(day: string): PriceCandleRow | null {
    const rs = this.byDay.get(day);
    if (!rs?.length) return null;
    return [...rs].sort((a, b) => a.updateVintage.localeCompare(b.updateVintage)).at(-1) ?? null;
  }
  vintages(day: string): string[] {
    return (this.byDay.get(day) ?? []).map((r) => r.updateVintage).sort();
  }
  /** amount (human decimal string of the base asset) -> quote currency at `day`'s close. */
  convert(amount: string, day: string): Conversion {
    const c = this.latest(day);
    if (!c)
      return {
        ok: false,
        code: "PRICE_UNAVAILABLE",
        day,
        reason: "no candle for requested day (gap)",
        retryable: false,
      };
    return {
      ok: true,
      usd: formatDec(mulDec(parseDec(amount), parseDec(c.close))),
      day,
      vintage: c.updateVintage,
      basis: "close",
      sourceHash: c.rawObjectHash,
    };
  }
  /** Inverse helper: quote -> base at 8 fractional digits (rounded half away from zero). */
  invert(usd: string, day: string): Conversion {
    const c = this.latest(day);
    if (!c)
      return {
        ok: false,
        code: "PRICE_UNAVAILABLE",
        day,
        reason: "no candle for requested day (gap)",
        retryable: false,
      };
    return {
      ok: true,
      usd: formatDec(divDec(parseDec(usd), parseDec(c.close), 8)),
      day,
      vintage: c.updateVintage,
      basis: "close",
      sourceHash: c.rawObjectHash,
    };
  }
}

export const priceFingerprint = (rows: unknown[][]): string =>
  sha256Hex(`ohlc:${rows.length ? rows[0]!.length : 0}`);
