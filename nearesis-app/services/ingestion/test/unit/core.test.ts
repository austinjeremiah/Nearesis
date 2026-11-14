import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { classifyQuote } from "../../src/adapters/oneclick.ts";
import { checkSql, parseTableRefs } from "../../src/adapters/bigquery-guard.ts";
import { parseOhlc, plainNumber } from "../../src/adapters/price.ts";
import { parseExplorerPage, reconcileSwap } from "../../src/adapters/explorer-parse.ts";
import { FakeClock } from "../../src/clock.ts";
import {
  addDec,
  cmpDec,
  divDec,
  formatDec,
  normalizeDecString,
  parseDec,
  unitsToDecimal,
} from "../../src/decimal.ts";
import { canonicalJson } from "../../src/hash.ts";
import { canonicalDigest } from "../../src/normalize.ts";
import { AuthCircuitBreaker } from "../../src/rate/breaker.ts";
import { RedisTokenBucket } from "../../src/rate/limiter.ts";
import { ContractRegistry } from "../../src/registry/contracts.ts";
import { replay } from "../../src/replay.ts";

describe("decimal (property-style)", () => {
  it("round-trips and adds exactly for random bigint magnitudes", () => {
    for (let i = 0; i < 300; i++) {
      const a = BigInt(`0x${randomBytes(1 + (i % 20)).toString("hex")}`);
      const b = BigInt(`0x${randomBytes(1 + ((i * 7) % 20)).toString("hex")}`);
      const sc = i % 30;
      const da = parseDec(unitsToDecimal(a.toString(), sc));
      const db = parseDec(unitsToDecimal(b.toString(), sc));
      expect(formatDec(addDec(da, db))).toBe(unitsToDecimal((a + b).toString(), sc));
      expect(parseDec(formatDec(da)).int).toBe(a);
      expect(cmpDec(da, db)).toBe(a < b ? -1 : a > b ? 1 : 0);
    }
  });
  it("divides with half-away-from-zero rounding and normalizes", () => {
    expect(formatDec(divDec(parseDec("1"), parseDec("3"), 4))).toBe("0.3333");
    expect(formatDec(divDec(parseDec("2"), parseDec("3"), 4))).toBe("0.6667");
    expect(normalizeDecString("1.2300")).toBe("1.23");
    expect(() => unitsToDecimal("1", 81)).toThrow();
  });
});

describe("token bucket (fake clock, real redis)", () => {
  it("grants one slot per interval and reports the wait", async () => {
    const redis = new Redis("redis://127.0.0.1:56379");
    const clock = new FakeClock();
    const b = new RedisTokenBucket(
      redis,
      `ingestion:rate:test:${randomBytes(6).toString("hex")}`,
      clock,
      5000,
    );
    expect(await b.tryAcquire()).toBe(0);
    expect(await b.tryAcquire()).toBe(5000);
    clock.advance(4999);
    expect(await b.tryAcquire()).toBe(1);
    clock.advance(1);
    expect(await b.tryAcquire()).toBe(0);
    await b.penalizeUntil(clock.now() + 20_000);
    expect(await b.tryAcquire()).toBe(20_000);
    redis.disconnect();
  });
});

describe("circuit breaker", () => {
  it("allows at most 3 auth failures per 120 s window", () => {
    const clock = new FakeClock();
    const br = new AuthCircuitBreaker(clock);
    br.recordAuthFailure();
    br.recordAuthFailure();
    br.open();
    expect(br.allowRequest()).toBe(false);
    clock.advance(30_000);
    expect(br.allowRequest()).toBe(true);
    br.recordAuthFailure();
    br.open();
    clock.advance(60_000);
    expect(br.allowRequest()).toBe(false);
    clock.advance(40_000);
    expect(br.allowRequest()).toBe(true);
    br.recordSuccess();
    expect(br.state).toBe("closed");
  });
});

describe("1Click classifier", () => {
  const ok = JSON.stringify({
    correlationId: "c",
    quoteRequest: {},
    quote: {
      amountIn: "1",
      amountInFormatted: "1",
      amountInUsd: "1",
      minAmountIn: "1",
      amountOut: "3000000",
      amountOutFormatted: "3",
      amountOutUsd: "3",
      minAmountOut: "1",
      timeEstimate: 1,
    },
  });
  const enc = (s: string) => new TextEncoder().encode(s);
  it("covers every class", () => {
    expect(classifyQuote({ status: 200, body: enc(ok), destDecimals: 6 }).class).toBe("OK");
    expect(classifyQuote({ status: 201, body: enc(ok), destDecimals: 6 }).class).toBe("OK"); // live API answers 201 Created
    expect(classifyQuote({ status: 400, body: enc('{"message":"No route found"}') }).class).toBe("NO_QUOTE");
    expect(classifyQuote({ status: 400, body: enc('{"message":"bad recipient"}') }).class).toBe(
      "INVALID_OUTPUT",
    );
    expect(classifyQuote({ status: null, body: null, error: "network" }).class).toBe("NETWORK_ERROR");
    expect(classifyQuote({ status: 502, body: null }).class).toBe("NETWORK_ERROR");
    expect(classifyQuote({ status: null, body: null, error: "timeout" }).class).toBe("TIMEOUT");
    expect(classifyQuote({ status: 200, body: enc("{}") }).class).toBe("INVALID_OUTPUT");
    expect(classifyQuote({ status: 200, body: enc(ok.replace('"3000000"', '"0"')) }).class).toBe(
      "INVALID_OUTPUT",
    );
    expect(classifyQuote({ status: 200, body: enc(ok), destDecimals: 18 }).class).toBe("INVALID_OUTPUT"); // impossible scale
  });
});

describe("BigQuery guard parsing", () => {
  const T = "`bigquery-public-data.crypto_near_mainnet_us.transactions`";
  const R = "`bigquery-public-data.crypto_near_mainnet_us.receipt_actions`";
  it("parses table refs and aliases", () => {
    const r = parseTableRefs(`SELECT 1 FROM ${T} t JOIN ${R} AS ra ON ra.a = t.a WHERE 1=1`);
    expect(r.map((x) => [x.table, x.alias])).toEqual([
      ["transactions", "t"],
      ["receipt_actions", "ra"],
    ]);
  });
  it("accepts bounded, rejects missing predicate on the second joined table", () => {
    const ok = `SELECT 1 FROM ${T} t JOIN ${R} ra ON ra.a=t.a WHERE t.block_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-02' AND ra.block_date >= '2026-10-01' AND ra.block_date < '2026-10-02'`;
    expect(checkSql(ok).ok).toBe(true);
    const bad = `SELECT 1 FROM ${T} t JOIN ${R} ra ON ra.a=t.a WHERE t.block_date >= DATE '2026-10-01' AND t.block_date < DATE '2026-10-02'`;
    const v = checkSql(bad);
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toContain("receipt_actions");
  });
  it("resolves DECLAREd bounds and rejects reversed or OR predicates", () => {
    const d = `DECLARE s DATE DEFAULT DATE '2026-08-01'; DECLARE e DATE DEFAULT DATE '2026-09-01'; SELECT 1 FROM ${T} t WHERE t.block_date >= s AND t.block_date < e`;
    expect(checkSql(d).ok).toBe(true);
    expect(
      checkSql(
        `SELECT 1 FROM ${T} t WHERE t.block_date >= DATE '2026-10-05' AND t.block_date < DATE '2026-10-01'`,
      ).ok,
    ).toBe(false);
    expect(
      checkSql(
        `SELECT 1 FROM ${T} t WHERE t.block_date >= DATE '2026-10-01' AND t.block_date < DATE '2026-10-02' OR 1=1`,
      ).ok,
    ).toBe(false);
  });
});

describe("explorer parse and merge", () => {
  it("rejects non-array and verifies optional checksum", () => {
    expect(parseExplorerPage(new TextEncoder().encode("{}"))).toMatchObject({
      ok: false,
      reasonCode: "NOT_ARRAY",
    });
    expect(
      parseExplorerPage(new TextEncoder().encode("[]"), { "x-body-sha256": "0".repeat(64) }),
    ).toMatchObject({ reasonCode: "CHECKSUM_MISMATCH" });
  });
  it("never regresses a terminal status and flags terminal conflicts", () => {
    const base = { swapKey: "k", createdAt: "t", amountIn: "1", amountOut: "2", record: {} as never };
    expect(
      reconcileSwap(
        { ...base, status: "SUCCESS", rawObjectHash: "a" },
        { ...base, status: "PROCESSING", rawObjectHash: "b" },
      ),
    ).toBe("stale");
    expect(
      reconcileSwap(
        { ...base, status: "PENDING_DEPOSIT", rawObjectHash: "a" },
        { ...base, status: "SUCCESS", rawObjectHash: "b" },
      ),
    ).toBe("update");
    expect(
      reconcileSwap(
        { ...base, status: "SUCCESS", rawObjectHash: "a" },
        { ...base, status: "FAILED", rawObjectHash: "b" },
      ),
    ).toBe("conflict");
    expect(reconcileSwap(undefined, { ...base, status: "SUCCESS", rawObjectHash: "b" })).toBe("insert");
  });
});

describe("price number handling", () => {
  it("keeps literal precision and expands exponents", () => {
    expect(plainNumber("4.123456789012345678")).toBe("4.123456789012345678");
    expect(plainNumber("1e-7")).toBe("0.0000001");
    expect(plainNumber("2.5E+3")).toBe("2500");
    const c = parseOhlc(new TextEncoder().encode("[[86400000, 1.10, 2, 0.5, 1.123456789012345678901]]"));
    expect(c[0]).toMatchObject({ open: "1.1", close: "1.123456789012345678901" });
  });
});

describe("registry effective dating", () => {
  const e = (from: string, to: string | null, tax: string) => ({
    chain: "near",
    accountId: "a.near",
    project: "P",
    taxonomy: tax,
    validFrom: from,
    validTo: to,
    ownershipVerification: "verified" as const,
    evidenceUrl: "https://docs.near.org/",
    ambiguityScore: 0,
  });
  it("treats validTo as exclusive and validFrom as inclusive", () => {
    const r = new ContractRegistry([
      e("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", "x"),
      e("2026-02-01T00:00:00Z", null, "y"),
    ]);
    expect(r.lookup("near", "a.near", "2026-01-31T23:59:59.999Z")).toMatchObject({
      entry: { taxonomy: "x" },
    });
    expect(r.lookup("near", "a.near", "2026-02-01T00:00:00Z")).toMatchObject({ entry: { taxonomy: "y" } });
    expect(r.conflicts).toHaveLength(0);
  });
});

describe("canonical digest", () => {
  it("is stable under key order and differs on content", async () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }),
    );
    const o = await replay("fx.snapshot.p02-duplicates");
    expect(canonicalDigest(o.tables)).toBe(o.digest);
    const t = structuredClone(o.tables);
    t.intents_swaps[0]!.amountIn = "999";
    expect(canonicalDigest(t)).not.toBe(o.digest);
  });
});
