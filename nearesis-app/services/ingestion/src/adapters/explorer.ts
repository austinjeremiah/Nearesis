import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceWatermark } from "@nearesis/contracts";
import type { Redis } from "ioredis";
import type pg from "pg";
import type { RawArchive } from "../archive/archive.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db.ts";
import { IngestionError } from "../errors.ts";
import { sha256Hex, canonicalJson } from "../hash.ts";
import type { HttpClient } from "../http/client.ts";
import { HttpNetworkError, HttpTimeoutError } from "../http/client.ts";
import type { CredentialSource } from "../http/credentials.ts";
import { AuthCircuitBreaker, DEFAULT_BREAKER, type BreakerConfig } from "../rate/breaker.ts";
import { credentialRateKey, EXPLORER_INTERVAL_MS, RedisLease, RedisTokenBucket } from "../rate/limiter.ts";
import {
  type ExplorerCursor,
  type ExplorerTx,
  type StoredSwap,
  explorerSchemaFingerprint,
  normStatus,
  amountOrNull,
  parseExplorerPage,
  reconcileSwap,
  swapKeyOf,
} from "./explorer-parse.ts";

export const EXPLORER_ADAPTER_VERSION = "explorer-1.0.0";
const PROVIDER = "near-explorer" as const;

export type RunStatus =
  | "complete"
  | "max_pages"
  | "auth_blocked"
  | "circuit_open"
  | "quarantined"
  | "quarantine_cap"
  | "transient_failure"
  | "rate_limited"
  | "lease_held";

export interface RunResult {
  status: RunStatus;
  pagesCommitted: number;
  swapsInserted: number;
  swapsUpdated: number;
  duplicatesSkipped: number;
  cursor: ExplorerCursor | null;
  blocker?: BlockerDraft;
  quarantineReason?: string;
  /** Quarantined pages skipped (gap recorded, cursor advanced) by this call. */
  pagesSkipped?: number;
}

export interface BlockerDraft {
  draft: true;
  provider: typeof PROVIDER;
  reason_code: "AUTH_REJECTED";
  retryability: "human_action_needed";
  last_checkpoint: string | null;
  http_statuses: number[];
  detected_at: string;
  summary: string;
  path?: string;
}

export interface ExplorerFaults {
  /** Called inside the page transaction after swaps are written, before the cursor is written. Throw to simulate a crash. */
  midPage?: (pageNo: number) => void;
  /** Called after a page (swaps + cursor) is committed. Throw to simulate a crash. */
  afterPageCommit?: (pageNo: number) => void;
}

export interface ExplorerDeps {
  http: HttpClient;
  archive: RawArchive;
  db: Db;
  redis: Redis;
  clock: Clock;
  credentials: CredentialSource;
  baseUrl?: string;
  credentialName?: string;
  streamKey?: string;
  pageSize?: number;
  blockerDir?: string;
  breaker?: AuthCircuitBreaker;
  breakerConfig?: BreakerConfig;
  sourceEnvironment?: "live" | "fixture_synthetic" | "fixture_recorded";
  maxTransientRetries?: number;
  max429Retries?: number;
  faults?: ExplorerFaults;
  intervalMs?: number;
  lagThresholdMs?: number;
}

export interface RunOptions {
  maxPages?: number;
  startUnix?: number; // non-inclusive (provider semantics)
  endUnix?: number; // non-inclusive
  /** Start of the window being collected, used to describe uncovered intervals. */
  windowStartUTC?: string;
  windowEndUTC?: string;
  /**
   * Bounded skip-and-record for quarantined pages. The page stays quarantined and promotes no facts; only its cursor
   * position is taken from the raw bytes so collection can continue. Without this option a quarantined page stops the run.
   */
  skipQuarantined?: {
    /** False once a cap is reached; the run then stops with status `quarantine_cap`. A hash already counted is always allowed. */
    allow: (rawObjectHash: string) => boolean;
    record: (s: SkippedPage) => Promise<void>;
  };
}

export interface SkippedPage {
  rawObjectHash: string;
  reasonCode: string;
  detail: string;
  fromUTC: string;
  toUTC: string;
  cursor: ExplorerCursor;
  items: number;
}

/** Reasons whose raw bytes still carry a trustworthy page position. Bad JSON and checksum mismatches never skip. */
export const SKIPPABLE_REASONS: ReadonlySet<string> = new Set(["BAD_SCHEMA", "PAGE_LIMIT"]);

/**
 * Best-effort position of a quarantined page: createdAt range of its items and the cursor after its last item. Null when
 * the bytes do not parse as an array of objects with a usable last depositAddress and at least one valid createdAt.
 */
export function salvagePage(
  body: Uint8Array,
): { fromUTC: string; toUTC: string; cursor: ExplorerCursor; items: number } | null {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (!Array.isArray(json) || json.length === 0) return null;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const it of json as Array<Record<string, unknown> | null>) {
    const t = typeof it?.createdAt === "string" ? Date.parse(it.createdAt) : Number.NaN;
    if (Number.isNaN(t)) continue;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  const last = json[json.length - 1] as Record<string, unknown> | null;
  const addr = last?.depositAddress;
  const memo = last?.depositMemo ?? "";
  if (!Number.isFinite(lo) || typeof addr !== "string" || addr === "" || typeof memo !== "string")
    return null;
  return {
    fromUTC: new Date(lo).toISOString(),
    toUTC: new Date(hi).toISOString(),
    cursor: { lastDepositAddress: addr, lastDepositMemo: memo },
    items: json.length,
  };
}

export const quarantineGapCode = (rawObjectHash: string): string => `QUARANTINED_PAGE:${rawObjectHash}`;

/** Records the Postgres gap and moves the stored cursor past a quarantined page (the quarantine row stays). Idempotent. */
export async function advancePastQuarantined(
  db: Db,
  streamKey: string,
  s: Pick<SkippedPage, "rawObjectHash" | "fromUTC" | "toUTC" | "cursor">,
  moveCursor = true,
): Promise<void> {
  await db.tx(async (c) => {
    const code = quarantineGapCode(s.rawObjectHash);
    await c.query(
      `INSERT INTO ingestion.quality_gaps(provider_id, dataset, from_utc, to_utc, state, reason_code)
       SELECT $1,'intents_swaps',$2,$3,'unavailable',$4
        WHERE NOT EXISTS (SELECT 1 FROM ingestion.quality_gaps WHERE provider_id=$1 AND dataset='intents_swaps' AND reason_code=$4)`,
      [PROVIDER, s.fromUTC, s.toUTC, code],
    );
    if (!moveCursor) return;
    await c.query(
      `UPDATE ingestion.cursor_state SET cursor=$3, page_hash=$4, updated_at=now()
        WHERE provider_id=$1 AND stream_key=$2`,
      [PROVIDER, streamKey, JSON.stringify(s.cursor), s.rawObjectHash],
    );
  });
}

type FetchOutcome =
  | { kind: "ok"; status: 200; body: Uint8Array; headers: Record<string, string>; receivedAtMs: number }
  | { kind: "auth_rejected"; statuses: number[] }
  | { kind: "circuit_open" }
  | { kind: "transient"; status: number | null }
  | { kind: "rate_limited" };

export interface BackoffEvent {
  attempt: number;
  delayMs: number;
  source: "retry-after" | "exponential";
}

export class ExplorerCollector {
  readonly providerId = PROVIDER;
  readonly mode = "live" as const;
  readonly adapterVersion = EXPLORER_ADAPTER_VERSION;
  readonly breaker: AuthCircuitBreaker;
  readonly backoffLog: BackoffEvent[] = [];
  /** Times (per injected clock) at which the global rate limiter granted a request slot. */
  readonly grantLog: number[] = [];
  readonly streamKey: string;
  readonly baseUrl: string;
  readonly pageSize: number;
  private bucket?: RedisTokenBucket;
  private readonly credentialName: string;

  constructor(private readonly d: ExplorerDeps) {
    this.breaker = d.breaker ?? new AuthCircuitBreaker(d.clock, d.breakerConfig ?? DEFAULT_BREAKER);
    this.streamKey = d.streamKey ?? "transactions:default";
    this.baseUrl = d.baseUrl ?? "https://explorer.near-intents.org";
    this.pageSize = d.pageSize ?? 1000;
    this.credentialName = d.credentialName ?? "INTENTS_EXPLORER_JWT";
  }

  rateKey(): string {
    return this.getBucket().key;
  }

  private getBucket(): RedisTokenBucket {
    if (!this.bucket) {
      const jwt = this.d.credentials.get(this.credentialName) ?? "no-credential";
      this.bucket = new RedisTokenBucket(
        this.d.redis,
        credentialRateKey("explorer", jwt),
        this.d.clock,
        this.d.intervalMs ?? EXPLORER_INTERVAL_MS,
      );
    }
    return this.bucket;
  }

  private nowIso(): string {
    return new Date(this.d.clock.now()).toISOString();
  }

  private async trace(
    kind: string,
    subject: string | null,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.d.db.query(
      "INSERT INTO ingestion.trace_events(ts, provider_id, kind, subject, detail) VALUES ($1,$2,$3,$4,$5)",
      [this.nowIso(), PROVIDER, kind, subject, JSON.stringify(detail)],
    );
  }

  /** Adapter contract: checkAuth (one rate-limited minimal request). */
  async checkAuth(): Promise<{ ok: boolean; status: number | null }> {
    const o = await this.fetchPage(null, 1, {});
    if (o.kind === "ok") return { ok: true, status: 200 };
    if (o.kind === "auth_rejected") return { ok: false, status: o.statuses[o.statuses.length - 1] ?? null };
    return { ok: false, status: o.kind === "transient" ? o.status : null };
  }

  getSchemaFingerprint(items: unknown[]): string {
    return explorerSchemaFingerprint(items);
  }

  async checkpoint(streamKey: string = this.streamKey): Promise<{
    cursor: ExplorerCursor | null;
    pageHash: string | null;
    retrievedAt: string | null;
    schemaVersion: string | null;
    latestEventTime: string | null;
    pagesCommitted: number;
  }> {
    const r = await this.d.db.query<{
      cursor: ExplorerCursor | null;
      page_hash: string | null;
      retrieved_at: Date | null;
      schema_version: string | null;
      latest_event_time: Date | null;
      pages_committed: number;
    }>("SELECT * FROM ingestion.cursor_state WHERE provider_id=$1 AND stream_key=$2", [PROVIDER, streamKey]);
    const row = r.rows[0];
    return {
      cursor: row?.cursor ?? null,
      pageHash: row?.page_hash ?? null,
      retrievedAt: row?.retrieved_at?.toISOString() ?? null,
      schemaVersion: row?.schema_version ?? null,
      latestEventTime: row?.latest_event_time?.toISOString() ?? null,
      pagesCommitted: row?.pages_committed ?? 0,
    };
  }

  async health(): Promise<{
    health: string;
    watermarkState: SourceWatermark["state"];
    detail: Record<string, unknown>;
  }> {
    const r = await this.d.db.query<{
      health: string;
      watermark_state: SourceWatermark["state"];
      detail: Record<string, unknown>;
    }>(
      "SELECT health, watermark_state, detail FROM ingestion.source_health WHERE provider_id=$1 AND stream_key=$2",
      [PROVIDER, this.streamKey],
    );
    const row = r.rows[0];
    return row
      ? { health: row.health, watermarkState: row.watermark_state, detail: row.detail }
      : { health: "unknown", watermarkState: "unavailable", detail: {} };
  }

  async watermark(): Promise<SourceWatermark> {
    const h = await this.health();
    const cp = await this.checkpoint();
    const gaps = await this.d.db.query<{ n: string }>(
      "SELECT count(*) n FROM ingestion.quality_gaps WHERE provider_id=$1",
      [PROVIDER],
    );
    return {
      providerId: PROVIDER,
      newestEventTime: cp.latestEventTime,
      lastFullScanAt: (h.detail.lastFullScanAt as string | undefined) ?? null,
      gapCount: Number(gaps.rows[0]?.n ?? 0),
      providerLagSeconds: cp.latestEventTime
        ? Math.max(0, (this.d.clock.now() - Date.parse(cp.latestEventTime)) / 1000)
        : null,
      schemaVersion: cp.schemaVersion,
      state: h.watermarkState,
    };
  }

  private async saveHealth(
    health: string,
    watermark: SourceWatermark["state"],
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.d.db.query(
      `INSERT INTO ingestion.source_health(provider_id, stream_key, health, watermark_state, circuit, detail, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (provider_id, stream_key) DO UPDATE SET health=$3, watermark_state=$4, circuit=$5, detail=$6, updated_at=$7`,
      [
        PROVIDER,
        this.streamKey,
        health,
        watermark,
        JSON.stringify(this.breaker.snapshot()),
        JSON.stringify(detail),
        this.nowIso(),
      ],
    );
  }

  private async loadBreaker(): Promise<void> {
    const r = await this.d.db.query<{ circuit: ReturnType<AuthCircuitBreaker["snapshot"]> }>(
      "SELECT circuit FROM ingestion.source_health WHERE provider_id=$1 AND stream_key=$2",
      [PROVIDER, this.streamKey],
    );
    const c = r.rows[0]?.circuit;
    if (c && "state" in c && this.breaker.state === "closed" && this.breaker.failuresMs.length === 0)
      this.breaker.restore(c);
  }

  private pageUrl(cursor: ExplorerCursor | null, size: number, q: RunOptions): string {
    const p = new URLSearchParams({ numberOfTransactions: String(size), direction: "next" });
    if (cursor) {
      p.set("lastDepositAddress", cursor.lastDepositAddress);
      if (cursor.lastDepositMemo) p.set("lastDepositMemo", cursor.lastDepositMemo);
    }
    if (q.startUnix !== undefined) p.set("startTimestampUnix", String(q.startUnix));
    if (q.endUnix !== undefined) p.set("endTimestampUnix", String(q.endUnix));
    return `${this.baseUrl}/api/v0/transactions?${p.toString()}`;
  }

  /** One logical page fetch: rate limit, 429 backoff, 401/403 confirmation retry, circuit breaker, transient retries. */
  async fetchPage(cursor: ExplorerCursor | null, size: number, q: RunOptions): Promise<FetchOutcome> {
    const url = this.pageUrl(cursor, size, q);
    const bucket = this.getBucket();
    let n429 = 0;
    let transient = 0;
    let authSeen = 0;
    const authStatuses: number[] = [];
    for (;;) {
      if (!this.breaker.allowRequest()) return { kind: "circuit_open" };
      this.grantLog.push(await bucket.acquire());
      let res;
      try {
        res = await this.d.http.request({
          method: "GET",
          url,
          auth: { credential: this.credentialName, header: "authorization", scheme: "Bearer" },
          ...(authSeen === 1 ? { authConfirm: true } : {}),
        });
      } catch (e) {
        if (e instanceof IngestionError && e.code === "AUTH_REJECTED") {
          // the HTTP client's auth circuit is open: no request was sent, the credential must be rotated
          this.breaker.open();
          return { kind: "auth_rejected", statuses: authStatuses };
        }
        if (!(e instanceof HttpTimeoutError || e instanceof HttpNetworkError)) throw e;
        if (++transient > (this.d.maxTransientRetries ?? 2)) return { kind: "transient", status: null };
        await this.backoff(transient, undefined);
        continue;
      }
      if (res.status === 200) {
        this.breaker.recordSuccess();
        return {
          kind: "ok",
          status: 200,
          body: res.body,
          headers: res.headers,
          receivedAtMs: res.receivedAtMs,
        };
      }
      if (res.status === 429) {
        if (++n429 > (this.d.max429Retries ?? 5)) return { kind: "rate_limited" };
        const delay = await this.backoff(n429, res.headers["retry-after"]);
        await bucket.penalizeUntil(this.d.clock.now() + delay);
        await this.trace("explorer.429", null, { attempt: n429, delayMs: delay });
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        authStatuses.push(res.status);
        this.breaker.recordAuthFailure();
        await this.trace("explorer.auth_rejected", null, { status: res.status, attempt: authSeen + 1 });
        const probing = this.breaker.state === "half_open";
        if (authSeen === 0 && !probing) {
          authSeen = 1; // exactly one confirmation retry
          continue;
        }
        this.breaker.open();
        return { kind: "auth_rejected", statuses: authStatuses };
      }
      if (++transient > (this.d.maxTransientRetries ?? 2)) return { kind: "transient", status: res.status };
      await this.backoff(transient, undefined);
    }
  }

  /** Computes and records the delay (Retry-After if present, else exponential with a 5 s floor) and sleeps it. */
  private async backoff(attempt: number, retryAfter: string | undefined): Promise<number> {
    let delay: number;
    let source: BackoffEvent["source"];
    const ra = retryAfter !== undefined ? parseRetryAfter(retryAfter, this.d.clock.now()) : null;
    if (ra !== null) {
      delay = Math.max(0, ra);
      source = "retry-after";
    } else {
      delay = Math.min(5000 * 2 ** (attempt - 1), 300_000);
      source = "exponential";
    }
    this.backoffLog.push({ attempt, delayMs: delay, source });
    await this.d.clock.sleep(delay);
    return delay;
  }

  private emitBlocker = async (statuses: number[], cursor: ExplorerCursor | null): Promise<BlockerDraft> => {
    const draft: BlockerDraft = {
      draft: true,
      provider: PROVIDER,
      reason_code: "AUTH_REJECTED",
      retryability: "human_action_needed",
      last_checkpoint: cursor ? JSON.stringify(cursor) : null,
      http_statuses: statuses,
      detected_at: this.nowIso(),
      summary:
        "Explorer rejected the partner credential (401/403) after a confirmation retry; circuit opened. Rotate or restore the JWT.",
    };
    if (this.d.blockerDir) {
      await mkdir(this.d.blockerDir, { recursive: true });
      const path = join(
        this.d.blockerDir,
        `BLK-DRAFT-near-explorer-${sha256Hex(this.streamKey + draft.detected_at).slice(0, 8)}.json`,
      );
      await writeFile(path, JSON.stringify(draft, null, 2));
      draft.path = path;
    }
    await this.trace("explorer.blocker_draft", null, {
      reason_code: draft.reason_code,
      last_checkpoint: draft.last_checkpoint,
    });
    return draft;
  };

  /** Collect pages until the end of data, maxPages, or a stop condition. Cursor advances only after a page is committed. */
  async run(opts: RunOptions = {}): Promise<RunResult> {
    const result: RunResult = {
      status: "complete",
      pagesCommitted: 0,
      swapsInserted: 0,
      swapsUpdated: 0,
      duplicatesSkipped: 0,
      cursor: null,
    };
    const lease = new RedisLease(
      this.d.redis,
      `${this.getBucket().key.replace("ingestion:rate:", "ingestion:lease:")}:${this.streamKey}`,
      10 * 60_000,
    );
    if (!(await lease.acquire())) return { ...result, status: "lease_held" };
    try {
      await this.loadBreaker();
      let cp = await this.checkpoint();
      let cursor = cp.cursor;
      result.cursor = cursor;
      const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
      while (result.pagesCommitted < maxPages) {
        const out = await this.fetchPage(cursor, this.pageSize, opts);
        if (out.kind === "circuit_open") {
          result.status = "circuit_open";
          break;
        }
        if (out.kind === "auth_rejected") {
          result.status = "auth_blocked";
          result.blocker = await this.emitBlocker(out.statuses, cursor);
          await this.markAuthFailure(cursor, opts);
          break;
        }
        if (out.kind === "rate_limited") {
          result.status = "rate_limited";
          break;
        }
        if (out.kind === "transient") {
          result.status = "transient_failure";
          await this.saveHealth("degraded", "partial", { reason: `transient:${out.status ?? "network"}` });
          break;
        }
        const pageNo = cp.pagesCommitted + 1;
        const page = await this.commitPage(out, cursor, pageNo, result);
        if (page.kind === "quarantined") {
          const sk = opts.skipQuarantined;
          if (sk && page.skip) {
            if (!sk.allow(page.skip.rawObjectHash)) {
              result.status = "quarantine_cap";
              result.quarantineReason = page.reason;
              await this.saveHealth("degraded", "partial", { reason: `quarantine_cap:${page.reason}` });
              break;
            }
            await sk.record(page.skip);
            await advancePastQuarantined(this.d.db, this.streamKey, page.skip);
            await this.trace("explorer.quarantine_skipped", page.skip.rawObjectHash, {
              reason_code: page.reason,
              from: page.skip.fromUTC,
              to: page.skip.toUTC,
            });
            await this.saveHealth("healthy", "partial", { reason: `skipped_quarantined:${page.reason}` });
            result.pagesSkipped = (result.pagesSkipped ?? 0) + 1;
            cursor = page.skip.cursor;
            result.cursor = cursor;
            if (page.skip.items < this.pageSize) {
              result.status = "complete";
              break;
            }
            continue;
          }
          result.status = "quarantined";
          result.quarantineReason = page.reason;
          await this.saveHealth("degraded", "partial", { reason: `quarantined:${page.reason}` });
          break;
        }
        cursor = page.cursor ?? cursor;
        result.cursor = cursor;
        result.pagesCommitted++;
        cp = { ...cp, pagesCommitted: pageNo };
        this.d.faults?.afterPageCommit?.(pageNo);
        if (page.count < this.pageSize) {
          result.status = "complete";
          break;
        }
        if (result.pagesCommitted >= maxPages) result.status = "max_pages";
      }
      if (result.status === "complete") await this.markHealthy(opts);
      else if (result.status === "max_pages")
        await this.saveHealth("healthy", "partial", { reason: "max_pages" });
      return result;
    } finally {
      await lease.release();
    }
  }

  private async markAuthFailure(cursor: ExplorerCursor | null, opts: RunOptions): Promise<void> {
    await this.saveHealth("degraded", "unavailable", { reason: "AUTH_REJECTED", lastCheckpoint: cursor });
    const cp = await this.checkpoint();
    const from = opts.windowStartUTC ?? "1970-01-01T00:00:00.000Z";
    const to = cp.latestEventTime ? await this.oldestImported() : (opts.windowEndUTC ?? this.nowIso());
    await this.d.db.query(
      "INSERT INTO ingestion.quality_gaps(provider_id, dataset, from_utc, to_utc, state, reason_code) VALUES ($1,'intents_swaps',$2,$3,'unavailable','AUTH_REJECTED')",
      [PROVIDER, from, to],
    );
  }

  private async oldestImported(): Promise<string> {
    const r = await this.d.db.query<{ m: Date | null }>(
      "SELECT min(created_at) m FROM ingestion.explorer_swaps",
    );
    return (r.rows[0]?.m ?? new Date(this.d.clock.now())).toISOString();
  }

  private async markHealthy(_opts: RunOptions): Promise<void> {
    const cp = await this.checkpoint();
    const lag = cp.latestEventTime ? this.d.clock.now() - Date.parse(cp.latestEventTime) : null;
    const late = lag !== null && lag > (this.d.lagThresholdMs ?? 24 * 3600_000);
    await this.saveHealth("healthy", late ? "late" : "fresh", { lastFullScanAt: this.nowIso() });
  }

  private async commitPage(
    out: Extract<FetchOutcome, { kind: "ok" }>,
    cursorBefore: ExplorerCursor | null,
    pageNo: number,
    result: RunResult,
  ): Promise<
    | { kind: "ok"; cursor: ExplorerCursor | null; count: number }
    | { kind: "quarantined"; reason: string; skip: SkippedPage | null }
  > {
    const fetchedAtUTC = new Date(out.receivedAtMs).toISOString();
    const parsed = parseExplorerPage(out.body, out.headers);
    const env = this.d.sourceEnvironment ?? "live";
    const common = {
      providerId: PROVIDER,
      adapterVersion: EXPLORER_ADAPTER_VERSION,
      method: "GET",
      url: this.pageUrl(cursorBefore, this.pageSize, {}),
      sourceEnvironment: env,
      fetchedAtUTC,
      receivedAtUTC: fetchedAtUTC,
      responseStatus: 200,
      contentType: out.headers["content-type"] ?? "application/json",
      payload: out.body,
      cursorBefore: cursorBefore ? JSON.stringify(cursorBefore) : undefined,
      privacyVisibility: "partner_reported" as const,
      rateLimitHeaders: pickRateHeaders(out.headers),
    };
    if (!parsed.ok) {
      const arch = await this.d.archive.archive({
        ...common,
        providerEventAtUTC: null,
        providerEventAtNullReason: "payload quarantined; not parsed",
        completeness: "unknown",
        warnings: [`quarantined:${parsed.reasonCode}`],
      });
      await this.d.db.query(
        "INSERT INTO ingestion.quarantine(provider_id, kind, reason_code, raw_object_hash, detail) VALUES ($1,'explorer_page',$2,$3,$4)",
        [
          PROVIDER,
          parsed.reasonCode,
          arch.observation.payloadObjectHash,
          JSON.stringify({ detail: parsed.detail, pageNo }),
        ],
      );
      await this.trace("explorer.quarantine", arch.observation.payloadObjectHash, {
        reason_code: parsed.reasonCode,
        pageNo,
      });
      const salvaged = SKIPPABLE_REASONS.has(parsed.reasonCode) ? salvagePage(out.body) : null;
      return {
        kind: "quarantined",
        reason: parsed.reasonCode,
        skip: salvaged
          ? {
              rawObjectHash: arch.observation.payloadObjectHash,
              reasonCode: parsed.reasonCode,
              detail: parsed.detail,
              ...salvaged,
            }
          : null,
      };
    }
    const items = parsed.items;
    const last = items[items.length - 1];
    const newCursor: ExplorerCursor | null = last
      ? { lastDepositAddress: last.depositAddress, lastDepositMemo: last.depositMemo ?? "" }
      : null;
    const newest = items.reduce<string | null>(
      (m, t) => (m === null || t.createdAt > m ? t.createdAt : m),
      null,
    );
    const arch = await this.d.archive.archive({
      ...common,
      providerEventAtUTC: newest,
      providerEventAtNullReason: "empty page",
      cursorAfter: newCursor ? JSON.stringify(newCursor) : undefined,
      sourceSchemaVersion: explorerSchemaFingerprint(items).slice(0, 16),
      recordsClaimed: items.length,
      recordsParsed: items.length,
      completeness: items.length < this.pageSize ? "complete" : "partial",
      warnings: parsed.warnings,
    });
    const hash = arch.observation.payloadObjectHash;
    const tally = { inserted: 0, updated: 0, skipped: 0 };
    await this.d.db.tx(async (c) => {
      await upsertSwapPage(c, items, hash, fetchedAtUTC, out.receivedAtMs, tally);
      this.d.faults?.midPage?.(pageNo);
      await c.query(
        `INSERT INTO ingestion.cursor_state(provider_id, stream_key, cursor, page_hash, retrieved_at, schema_version, latest_event_time, pages_committed, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$5)
         ON CONFLICT (provider_id, stream_key) DO UPDATE SET cursor=COALESCE($3, ingestion.cursor_state.cursor), page_hash=$4, retrieved_at=$5, schema_version=$6,
           latest_event_time=GREATEST(ingestion.cursor_state.latest_event_time, $7), pages_committed=$8, updated_at=$5`,
        [
          PROVIDER,
          this.streamKey,
          newCursor ? JSON.stringify(newCursor) : null,
          hash,
          fetchedAtUTC,
          explorerSchemaFingerprint(items).slice(0, 16),
          newest,
          pageNo,
        ],
      );
    });
    result.swapsInserted += tally.inserted;
    result.swapsUpdated += tally.updated;
    result.duplicatesSkipped += tally.skipped;
    return { kind: "ok", cursor: newCursor, count: items.length };
  }

  /**
   * Day-granular collection (D05 / S11). Per UTC day: first page 200+[] => confirmed zero (complete);
   * pages fully read => complete; first request failed => unavailable (never zero); later failure => partial.
   */
  async collectDays(
    days: string[],
  ): Promise<
    Array<{ day: string; state: "complete" | "partial" | "unavailable"; rows: number; reason: string | null }>
  > {
    const out: Array<{
      day: string;
      state: "complete" | "partial" | "unavailable";
      rows: number;
      reason: string | null;
    }> = [];
    for (const day of days) {
      const startUnix = Date.parse(`${day}T00:00:00Z`) / 1000 - 1;
      const endUnix = Date.parse(`${day}T00:00:00Z`) / 1000 + 86400;
      const sub = new ExplorerCollector({
        ...this.d,
        streamKey: `${this.streamKey}:day:${day}`,
        breaker: this.breaker,
      });
      const r = await sub.run({
        startUnix,
        endUnix,
        windowStartUTC: `${day}T00:00:00.000Z`,
        windowEndUTC: `${day}T23:59:59.999Z`,
      });
      const rows = Number(
        (
          await this.d.db.query<{ n: string }>(
            "SELECT count(*) n FROM ingestion.explorer_swaps WHERE created_at >= $1 AND created_at < $2",
            [`${day}T00:00:00Z`, new Date(Date.parse(`${day}T00:00:00Z`) + 86400_000).toISOString()],
          )
        ).rows[0]?.n ?? 0,
      );
      let state: "complete" | "partial" | "unavailable";
      let reason: string | null = null;
      if (r.status === "complete") state = "complete";
      else if (r.pagesCommitted > 0) {
        state = "partial";
        reason =
          r.status === "quarantined"
            ? `QUARANTINED_${r.quarantineReason}`
            : `INCOMPLETE_${r.status.toUpperCase()}`;
      } else {
        state = "unavailable";
        reason =
          r.status === "quarantined"
            ? `QUARANTINED_${r.quarantineReason}`
            : r.status === "auth_blocked"
              ? "AUTH_REJECTED"
              : "PROVIDER_GAP";
      }
      await this.d.db.query(
        `INSERT INTO ingestion.source_coverage(provider_id, dataset, day, state, reason, observed_rows)
         VALUES ($1,'intents_swaps',$2,$3,$4,$5)
         ON CONFLICT (provider_id, dataset, day) DO UPDATE SET state=$3, reason=$4, observed_rows=$5, updated_at=now()`,
        [PROVIDER, day, state, reason, state === "unavailable" ? null : rows],
      );
      if (state !== "complete") {
        await this.d.db.query(
          "INSERT INTO ingestion.quality_gaps(provider_id, dataset, from_utc, to_utc, state, reason_code) VALUES ($1,'intents_swaps',$2,$3,$4,$5)",
          [PROVIDER, `${day}T00:00:00Z`, `${day}T23:59:59.999Z`, state, reason ?? "PROVIDER_GAP"],
        );
      }
      out.push({ day, state, rows: state === "unavailable" ? 0 : rows, reason });
    }
    return out;
  }
}

/** Reconciles one validated page into ingestion.explorer_swaps (inside the caller's transaction). Shared with the raw-archive replay. */
export async function upsertSwapPage(
  c: Pick<pg.PoolClient, "query">,
  items: ExplorerTx[],
  hash: string,
  fetchedAtUTC: string,
  receivedAtMs: number,
  tally: { inserted: number; updated: number; skipped: number },
): Promise<void> {
  for (const t of items) {
    const incoming: StoredSwap = {
      swapKey: swapKeyOf(t),
      status: normStatus(t.status),
      createdAt: t.createdAt,
      amountIn: amountOrNull(t.amountIn),
      amountOut: amountOrNull(t.amountOut),
      rawObjectHash: hash,
      record: t,
    };
    const ex = await c.query<{
      status: string;
      created_at: Date;
      amount_in: string | null;
      amount_out: string | null;
      raw_object_hash: string;
      record: ExplorerTx;
    }>(
      "SELECT status, created_at, amount_in, amount_out, raw_object_hash, record FROM ingestion.explorer_swaps WHERE swap_key=$1 FOR UPDATE",
      [incoming.swapKey],
    );
    const row = ex.rows[0];
    const existing: StoredSwap | undefined = row
      ? {
          swapKey: incoming.swapKey,
          status: row.status,
          createdAt: row.created_at.toISOString(),
          amountIn: row.amount_in,
          amountOut: row.amount_out,
          rawObjectHash: row.raw_object_hash,
          record: row.record,
        }
      : undefined;
    // normalise createdAt for comparison (DB returns ms ISO)
    incoming.createdAt = new Date(incoming.createdAt).toISOString();
    const action = reconcileSwap(existing, incoming);
    await c.query(
      "INSERT INTO ingestion.explorer_swap_versions(swap_key, raw_object_hash, status, observed_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [incoming.swapKey, hash, incoming.status, fetchedAtUTC],
    );
    if (action === "insert" || action === "update") {
      await c.query(
        `INSERT INTO ingestion.explorer_swaps(swap_key, status, created_at, amount_in, amount_out, raw_object_hash, version_ms, record)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (swap_key) DO UPDATE SET status=$2, amount_in=$4, amount_out=$5, raw_object_hash=$6, version_ms=$7, record=$8`,
        [
          incoming.swapKey,
          incoming.status,
          incoming.createdAt,
          incoming.amountIn,
          incoming.amountOut,
          hash,
          receivedAtMs,
          JSON.stringify(t),
        ],
      );
      if (action === "insert") tally.inserted++;
      else tally.updated++;
    } else if (action === "conflict") {
      await c.query(
        "INSERT INTO ingestion.quarantine(provider_id, kind, reason_code, raw_object_hash, detail) VALUES ($1,'swap_conflict','KEY_COLLISION',$2,$3)",
        [
          PROVIDER,
          hash,
          JSON.stringify({
            swapKey: incoming.swapKey,
            existingStatus: existing?.status,
            incomingStatus: incoming.status,
          }),
        ],
      );
    } else tally.skipped++;
  }
}

export function parseRetryAfter(v: string, nowMs: number): number | null {
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  const d = Date.parse(t);
  return Number.isNaN(d) ? null : Math.max(0, d - nowMs);
}

function pickRateHeaders(h: Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (/^(x-ratelimit-|retry-after)/.test(k)) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/** Deterministic checksum of the imported swap set (D03 / D18e). Independent of page boundaries and fetch times. */
export async function explorerImportChecksum(db: Db): Promise<{ checksum: string; count: number }> {
  const r = await db.query<{
    swap_key: string;
    status: string;
    amount_in: string;
    amount_out: string;
    record: unknown;
  }>(
    "SELECT swap_key, status, amount_in, amount_out, record FROM ingestion.explorer_swaps ORDER BY swap_key",
  );
  return {
    checksum: sha256Hex(
      canonicalJson(r.rows.map((x) => [x.swap_key, x.status, x.amount_in, x.amount_out, x.record])),
    ),
    count: r.rows.length,
  };
}
