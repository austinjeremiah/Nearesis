import { observe } from "@nearesis/acceptance";
import { fixtureHash, readFixtureBytes } from "@nearesis/test-fixtures";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PriceBook, buildPriceRows } from "../../src/adapters/price.ts";
import { setupEnv, type TestEnv } from "../helpers/env.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
}, 60_000);
afterAll(async () => env.close(), 60_000);

const ID = "fx.price.coingecko.near-usd-30d";

// D13: Daily price candles stored with provenance; missing days remain gaps
it("stores 29 provenance-complete candles, keeps the gap and both vintages, and refuses conversion on the gap", async () => {
  const cfg = JSON.parse(new TextDecoder().decode(readFixtureBytes(ID, "fetches.json"))) as {
    coinId: string;
    symbol: string;
    quoteCurrency: string;
    window: { from: string; to: string };
    fetches: Array<{ file: string; volumeFile?: string; fetchedAtUTC: string }>;
  };
  const inputs = [];
  for (const f of cfg.fetches) {
    const bytes = readFixtureBytes(ID, f.file);
    const a = await env.archive.archive({
      providerId: "coingecko",
      adapterVersion: "coingecko-price-1.0.0",
      method: "GET",
      url: `https://api.coingecko.com/api/v3/coins/${cfg.coinId}/ohlc?vs_currency=usd&days=30`,
      sourceEnvironment: "fixture_synthetic",
      fetchedAtUTC: f.fetchedAtUTC,
      receivedAtUTC: f.fetchedAtUTC,
      providerEventAtUTC: null,
      providerEventAtNullReason: "OHLC payload has per-candle timestamps only",
      responseStatus: 200,
      contentType: "application/json",
      payload: bytes,
      privacyVisibility: "public",
      completeness: "complete",
    });
    inputs.push({
      fileBytes: bytes,
      ...(f.volumeFile ? { volumeBytes: readFixtureBytes(ID, f.volumeFile) } : {}),
      fetchedAtUTC: f.fetchedAtUTC,
      rawObjectHash: a.observation.payloadObjectHash,
      sourceLabel: "SYNTHETIC" as const,
    });
  }
  const built = buildPriceRows(
    { coinId: cfg.coinId, symbol: cfg.symbol, quoteCurrency: cfg.quoteCurrency, window: cfg.window },
    inputs,
  );
  const days = new Set(built.rows.map((r) => r.bucketStartUTC.slice(0, 10)));
  expect(days.size).toBe(29); // (a)
  for (const r of built.rows) {
    expect(r.provider).toBe("coingecko");
    expect(r.symbol).toBe("NEAR");
    expect(r.quoteCurrency).toBe("usd");
    expect(r.interval).toBe("1d");
    for (const f of [r.providerTimestampUTC, r.fetchedAtUTC, r.updateVintage, r.rawObjectHash])
      expect(f).toBeTruthy();
    expect(await env.store.has(r.rawObjectHash)).toBe(true);
  }
  // (b) gap, not interpolated
  expect(built.gaps).toEqual([{ day: "2026-10-15", reason: "PROVIDER_GAP" }]);
  expect(days.has("2026-10-15")).toBe(false);
  // negative: out-of-window candle (2026-11-09) not attributed to the window
  expect(days.has("2026-11-09")).toBe(false);
  expect(built.outOfWindow.map((o) => o.day)).toEqual(["2026-11-09"]);
  // (c) both vintages kept; latest resolves to the later one
  const book = new PriceBook(built.rows);
  expect(book.vintages("2026-10-20")).toHaveLength(2);
  expect(book.latest("2026-10-20")?.close).toBe("3.77");
  expect(book.latest("2026-10-20")?.updateVintage).toBe("2026-11-10T06:00:00.000Z");
  // (d) conversion on the gap
  const gapConv = book.convert("2", "2026-10-15");
  expect(gapConv).toMatchObject({ ok: false, code: "PRICE_UNAVAILABLE", day: "2026-10-15" });
  // (e) exact decimal strings, no float loss
  const precise = book.latest("2026-10-13")!;
  expect(precise.close).toBe("4.123456789012345678");
  expect(String(Number(precise.close))).not.toBe(precise.close);
  const conv = book.convert("2", "2026-10-13");
  expect(conv).toMatchObject({ ok: true, usd: "8.246913578024691356" });
  observe({
    testId: "D13",
    observed: `${days.size} distinct daily candles (${built.rows.length} rows incl. ${book.vintages("2026-10-20").length} vintages of 2026-10-20); 2026-10-15 recorded as gap and conversion returned PRICE_UNAVAILABLE; out-of-window 2026-11-09 excluded; close ${precise.close} preserved exactly`,
    fixtureHash: fixtureHash(ID),
    evidence: {
      distinctDays: days.size,
      rows: built.rows.length,
      gaps: built.gaps,
      outOfWindow: built.outOfWindow,
      gapConversion: gapConv,
      latest1020: book.latest("2026-10-20")?.close,
      rawObjectHashes: [...new Set(built.rows.map((r) => r.rawObjectHash))],
    },
  });
}, 60_000);
