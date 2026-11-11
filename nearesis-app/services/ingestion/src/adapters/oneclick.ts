import type { QuoteAttempt } from "@nearesis/contracts";
import { z } from "zod";
import type { RawArchive } from "../archive/archive.ts";
import type { Clock } from "../clock.ts";
import {
  divDec,
  formatDec,
  isPlainDecimal,
  mulDec,
  normalizeDecString,
  parseDec,
  subDec,
  unitsToDecimal,
} from "../decimal.ts";
import { IngestionError } from "../errors.ts";
import { sha256Hex } from "../hash.ts";
import { HttpClient, HttpNetworkError, HttpTimeoutError } from "../http/client.ts";
import { redactBody } from "../http/redact.ts";

export const ONECLICK_ADAPTER_VERSION = "oneclick-1.0.0";
export const ONECLICK_BASE = "https://1click.chaindefuser.com";
const PROVIDER = "intents-1click" as const;
export type QuoteClass = QuoteAttempt["class"];

export const TokenResponse = z.looseObject({
  assetId: z.string().min(1),
  decimals: z.number().int().min(0).max(80),
  blockchain: z.string(),
  symbol: z.string(),
  price: z.number().nullable().optional(),
  priceUpdatedAt: z.string(),
  contractAddress: z.string().nullable().optional(),
  coingeckoId: z.string().nullable().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

const Quote = z.looseObject({
  amountIn: z.string().regex(/^\d+$/),
  amountInFormatted: z.string(),
  amountInUsd: z.string(),
  minAmountIn: z.string().regex(/^\d+$/),
  amountOut: z.string().regex(/^-?\d+$/),
  amountOutFormatted: z.string(),
  amountOutUsd: z.string(),
  minAmountOut: z.string().regex(/^\d+$/),
  timeEstimate: z.number(),
});
export const QuoteResponse = z.looseObject({
  correlationId: z.string().min(1),
  timestamp: z.string().optional(),
  signature: z.string().optional(),
  quoteRequest: z.looseObject({}),
  quote: Quote,
});

export interface QuoteRequestBody {
  dry: true;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
  slippageTolerance: number;
  originAsset: string;
  destinationAsset: string;
  depositType: string;
  refundTo: string;
  refundType: string;
  recipient?: string;
  recipientType: string;
  amount: string;
  deadline?: string;
  confidentiality?: string;
  [k: string]: unknown;
}

/** Enforces dry:true. Throws DRY_REQUIRED before any I/O if it is missing or not exactly `true`. */
export function assertDryQuote(body: unknown): asserts body is QuoteRequestBody {
  if (!body || typeof body !== "object" || (body as { dry?: unknown }).dry !== true) {
    throw new IngestionError("DRY_REQUIRED", false, { reason: "quote request must contain dry:true" });
  }
}

export interface ClassifyInput {
  status: number | null;
  body: Uint8Array | null;
  error?: "timeout" | "network";
  /** Decimals of the destination token when known (for impossible-scale detection). */
  destDecimals?: number;
}
export interface Classified {
  class: QuoteClass;
  amountOutBaseUnits: string | null;
  reason: string;
}

const NO_ROUTE =
  /(no\s+(route|quote|liquidity)|insufficient\s+liquidity|liquidity|unsupported|not\s+supported|amount\s+is\s+too\s+low)/i;

/** D07 classifier: every attempt gets exactly one class. */
export function classifyQuote(i: ClassifyInput): Classified {
  if (i.error === "timeout")
    return { class: "TIMEOUT", amountOutBaseUnits: null, reason: "request timed out" };
  if (i.error === "network" || i.status === null || i.status >= 500)
    return {
      class: "NETWORK_ERROR",
      amountOutBaseUnits: null,
      reason: i.status ? `HTTP ${i.status}` : "network error",
    };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(i.body ?? new Uint8Array()));
  } catch {
    return { class: "INVALID_OUTPUT", amountOutBaseUnits: null, reason: "response is not JSON" };
  }
  if (i.status < 200 || i.status >= 300) {
    const msg = (json as { message?: unknown } | null)?.message;
    if ((i.status === 400 || i.status === 404) && typeof msg === "string" && NO_ROUTE.test(msg))
      return { class: "NO_QUOTE", amountOutBaseUnits: null, reason: "provider reports no route/liquidity" };
    return { class: "INVALID_OUTPUT", amountOutBaseUnits: null, reason: `unexpected HTTP ${i.status}` };
  }
  const r = QuoteResponse.safeParse(json);
  if (!r.success) return { class: "INVALID_OUTPUT", amountOutBaseUnits: null, reason: "schema failure" };
  const q = r.data.quote;
  if (BigInt(q.amountOut) <= 0n)
    return { class: "INVALID_OUTPUT", amountOutBaseUnits: null, reason: "amountOut <= 0" };
  if (!isPlainDecimal(q.amountOutFormatted))
    return { class: "INVALID_OUTPUT", amountOutBaseUnits: null, reason: "amountOutFormatted not a decimal" };
  if (i.destDecimals !== undefined) {
    const expect = unitsToDecimal(q.amountOut, i.destDecimals);
    if (normalizeDecString(expect) !== normalizeDecString(q.amountOutFormatted))
      return { class: "INVALID_OUTPUT", amountOutBaseUnits: null, reason: "impossible decimal scale" };
  } else if (parseDec(q.amountOutFormatted).scale > 80) {
    return { class: "INVALID_OUTPUT", amountOutBaseUnits: null, reason: "impossible decimal scale" };
  }
  return { class: "OK", amountOutBaseUnits: q.amountOut, reason: "ok" };
}

/** Quote cost vs a declared benchmark (bps, 4 fractional digits), exact: (bench - out) / bench * 10000. */
export function quoteCostBps(amountOutFormatted: string, benchmarkOutFormatted: string): string | null {
  const b = parseDec(benchmarkOutFormatted);
  if (b.int <= 0n) return null;
  const diff = subDec(b, parseDec(amountOutFormatted));
  return formatDec(divDec(mulDec(diff, { int: 10000n, scale: 0 }), b, 4));
}

export interface SlotSpec {
  routeId: string;
  originAsset: string;
  destinationAsset: string;
  amountBaseUnits: string;
  privacyMode: "public" | "basic" | "advanced";
  scheduledBucketUTC: string;
  attemptNo: number;
  recipient: string;
  refundTo: string;
  destDecimals?: number;
}

export interface SamplerAttemptResult {
  attempt: QuoteAttempt;
  slot: "observed";
  reason: string;
  requestBody: QuoteRequestBody;
  status: number | null;
  payload: Uint8Array | null;
}
export interface UnavailableSlot {
  slot: "unavailable";
  routeId: string;
  amountBaseUnits: string;
  privacyMode: SlotSpec["privacyMode"];
  scheduledBucketUTC: string;
  attemptNo: number;
}

export interface OneClickDeps {
  http: HttpClient;
  archive: RawArchive;
  clock: Clock;
  baseUrl?: string;
  sourceEnvironment?: "live" | "fixture_synthetic" | "fixture_recorded";
  /** 1Click accepts X-API-Key or JWT; both are optional for dry quotes per spec (see D16 notes). */
  credentialName?: string;
  requestLog?: Array<{ method: string; path: string; dry: boolean | null }>;
}

/** Only GET /v0/tokens and POST /v0/quote (dry:true). Everything else throws before I/O. */
export class OneClickQuoteSampler {
  readonly providerId = PROVIDER;
  readonly adapterVersion = ONECLICK_ADAPTER_VERSION;
  readonly mode = "live" as const;
  readonly callLog: Array<{ method: string; path: string; dry: boolean | null }>;
  constructor(private readonly d: OneClickDeps) {
    this.callLog = d.requestLog ?? [];
  }
  private get base(): string {
    return this.d.baseUrl ?? ONECLICK_BASE;
  }
  private nowIso(): string {
    return new Date(this.d.clock.now()).toISOString();
  }

  /** Generic guard used by every call; also usable by tests to prove forbidden endpoints never reach I/O. */
  async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<never | { status: number; body: Uint8Array; headers: Record<string, string> }> {
    const isTokens = method === "GET" && path === "/v0/tokens";
    const isQuote = method === "POST" && path === "/v0/quote";
    if (!isTokens && !isQuote) {
      throw new IngestionError("ENDPOINT_NOT_ALLOWLISTED", false, {
        reason: "only GET /v0/tokens and POST /v0/quote are allowed",
        method,
        path,
      });
    }
    if (isQuote) assertDryQuote(body);
    this.callLog.push({ method, path, dry: isQuote ? true : null });
    const auth = this.d.credentialName
      ? ({ credential: this.d.credentialName, header: "authorization", scheme: "Bearer" } as const)
      : undefined;
    const res = await this.d.http.request({
      method: method as "GET" | "POST",
      url: `${this.base}${path}`,
      body,
      ...(auth ? { auth } : {}),
    });
    return { status: res.status, body: res.body, headers: res.headers };
  }

  async checkAuth(): Promise<{ ok: boolean; status: number }> {
    const r = await this.call("GET", "/v0/tokens");
    return { ok: r.status === 200, status: r.status };
  }

  getSchemaFingerprint(tokens: unknown[]): string {
    const first = (tokens[0] ?? {}) as Record<string, unknown>;
    return sha256Hex(
      Object.keys(first)
        .sort()
        .map((k) => `${k}:${first[k] === null ? "null" : typeof first[k]}`)
        .join("|"),
    );
  }

  async fetchTokens(): Promise<{ tokens: TokenResponse[]; objectHash: string }> {
    const fetchedAt = this.nowIso();
    const r = await this.call("GET", "/v0/tokens");
    if (r.status !== 200)
      throw new IngestionError("INVALID_INPUT", true, { reason: `tokens HTTP ${r.status}` });
    const json = JSON.parse(new TextDecoder().decode(r.body)) as unknown[];
    const tokens = json.map((t) => TokenResponse.parse(t));
    const a = await this.d.archive.archive({
      providerId: PROVIDER,
      adapterVersion: ONECLICK_ADAPTER_VERSION,
      method: "GET",
      url: `${this.base}/v0/tokens`,
      sourceEnvironment: this.d.sourceEnvironment ?? "live",
      fetchedAtUTC: fetchedAt,
      receivedAtUTC: this.nowIso(),
      providerEventAtUTC:
        tokens
          .map((t) => t.priceUpdatedAt)
          .sort()
          .at(-1) ?? null,
      responseStatus: r.status,
      contentType: r.headers["content-type"] ?? "application/json",
      payload: r.body,
      recordsClaimed: tokens.length,
      recordsParsed: tokens.length,
      sourceSchemaVersion: this.getSchemaFingerprint(json).slice(0, 16),
      privacyVisibility: "public",
      completeness: "complete",
    });
    return { tokens, objectHash: a.observation.payloadObjectHash };
  }

  /** Official OpenAPI (1click.chaindefuser.com/docs/v0/openapi.yaml): confidentiality enum is lowercase `public|basic|advanced`; public is the default and is omitted. */
  buildBody(s: SlotSpec): QuoteRequestBody {
    return {
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: s.originAsset,
      destinationAsset: s.destinationAsset,
      depositType: "ORIGIN_CHAIN",
      refundTo: s.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: s.recipient,
      recipientType: "DESTINATION_CHAIN",
      amount: s.amountBaseUnits,
      deadline: new Date(this.d.clock.now() + 10 * 60_000).toISOString(),
      ...(s.privacyMode === "public" ? {} : { confidentiality: s.privacyMode }),
    };
  }

  /** One dry quote attempt, classified. Never throws for provider/network failures; throws for policy violations. */
  async attempt(s: SlotSpec): Promise<SamplerAttemptResult> {
    const body = this.buildBody(s);
    assertDryQuote(body);
    const fetchedAt = this.nowIso();
    let status: number | null = null;
    let payload: Uint8Array | null = null;
    let err: "timeout" | "network" | undefined;
    try {
      const r = await this.call("POST", "/v0/quote", body);
      status = r.status;
      payload = r.body;
    } catch (e) {
      if (e instanceof HttpTimeoutError) err = "timeout";
      else if (e instanceof HttpNetworkError) err = "network";
      else throw e;
    }
    const c = classifyQuote({ status, body: payload, error: err, destDecimals: s.destDecimals });
    let rawObjectHash: string | null = null;
    if (payload) {
      const a = await this.d.archive.archive({
        providerId: PROVIDER,
        adapterVersion: ONECLICK_ADAPTER_VERSION,
        method: "POST",
        url: `${this.base}/v0/quote`,
        requestBody: redactBody(body),
        sourceEnvironment: this.d.sourceEnvironment ?? "live",
        fetchedAtUTC: fetchedAt,
        receivedAtUTC: this.nowIso(),
        providerEventAtUTC: null,
        providerEventAtNullReason: "dry quote responses carry no provider event time",
        responseStatus: status ?? 0,
        contentType: "application/json",
        payload,
        privacyVisibility: "public",
        completeness: c.class === "OK" ? "complete" : "unknown",
        warnings: c.class === "OK" ? [] : [`class:${c.class}`],
      });
      rawObjectHash = a.observation.payloadObjectHash;
    }
    const attempt: QuoteAttempt = {
      routeId: s.routeId,
      amountBaseUnits: s.amountBaseUnits,
      privacyMode: s.privacyMode,
      scheduledBucketUTC: s.scheduledBucketUTC,
      attemptNo: s.attemptNo,
      dry: true,
      class: c.class,
      amountOutBaseUnits: c.amountOutBaseUnits,
      fetchedAtUTC: fetchedAt,
      rawObjectHash,
    };
    return { attempt, slot: "observed", reason: c.reason, requestBody: body, status, payload };
  }

  /** Marks never-attempted grid slots as unavailable. They are not retried or backfilled. */
  static unavailable(
    s: Pick<SlotSpec, "routeId" | "amountBaseUnits" | "privacyMode" | "scheduledBucketUTC" | "attemptNo">,
  ): UnavailableSlot {
    return { slot: "unavailable", ...s };
  }
}

export interface GridSlot extends SlotSpec {
  /** Slot the scheduler never got to run (outage, budget). Recorded as unavailable and never backfilled. */
  skipped?: boolean;
}

/** Runs a fixed grid. Every slot gets exactly one row: an attempt class or `unavailable`. */
export async function runQuoteGrid(
  sampler: OneClickQuoteSampler,
  db: import("../db.ts").Db,
  slots: GridSlot[],
): Promise<Array<{ slot: "observed" | "unavailable"; class: QuoteClass | null }>> {
  const out: Array<{ slot: "observed" | "unavailable"; class: QuoteClass | null }> = [];
  for (const s of slots) {
    if (s.skipped) {
      await db.query(
        `INSERT INTO ingestion.quote_attempts(route_id, amount_base_units, privacy_mode, scheduled_bucket_utc, attempt_no, slot)
         VALUES ($1,$2,$3,$4,$5,'unavailable') ON CONFLICT DO NOTHING`,
        [s.routeId, s.amountBaseUnits, s.privacyMode, s.scheduledBucketUTC, s.attemptNo],
      );
      out.push({ slot: "unavailable", class: null });
      continue;
    }
    const r = await sampler.attempt(s);
    const a = r.attempt;
    await db.query(
      `INSERT INTO ingestion.quote_attempts(route_id, amount_base_units, privacy_mode, scheduled_bucket_utc, attempt_no, slot, class, amount_out_base_units, fetched_at, raw_object_hash, dry, reason)
       VALUES ($1,$2,$3,$4,$5,'observed',$6,$7,$8,$9,true,$10) ON CONFLICT DO NOTHING`,
      [
        a.routeId,
        a.amountBaseUnits,
        a.privacyMode,
        a.scheduledBucketUTC,
        a.attemptNo,
        a.class,
        a.amountOutBaseUnits,
        a.fetchedAtUTC,
        a.rawObjectHash,
        r.reason,
      ],
    );
    out.push({ slot: "observed", class: a.class });
  }
  return out;
}
