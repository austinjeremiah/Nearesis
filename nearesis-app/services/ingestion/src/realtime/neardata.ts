import type { Clock } from "../clock.ts";
import { aggregateBlock, type BlockAggregate } from "./aggregate.ts";

/** Anything that can hand out slots for one provider; the Redis token bucket implements it. Shared by every caller of that provider. */
export interface SlotSource {
  acquire(): Promise<number>;
  penalizeUntil(epochMs: number): Promise<void>;
}

export const NEARDATA_BASE = "https://mainnet.neardata.xyz";
/** Documented limit: 180 requests/minute/IP (github.com/fastnear/neardata-server). 400 ms spacing = 150/min leaves headroom for other callers. */
export const NEARDATA_INTERVAL_MS = 400;
export const NEARDATA_RATE_KEY = "ingestion:rate:fastnear-neardata:mainnet";

export interface BlockSource {
  lastFinalHeight(): Promise<number>;
  /** Aggregate of the FINAL block at this height, or null when the height has no block (skipped) or is not final yet. */
  getBlock(height: number): Promise<BlockAggregate | null>;
}

export class NeardataHttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

export class NeardataClient implements BlockSource {
  requests = 0;
  constructor(
    private readonly slots: SlotSource,
    private readonly clock: Clock,
    private readonly base: string = NEARDATA_BASE,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = 30_000,
  ) {}

  private async call(path: string, redirect: "follow" | "manual"): Promise<Response> {
    await this.slots.acquire(); // the one coordinator: historical and forward callers of this provider share the bucket
    this.requests++;
    const res = await this.fetchImpl(`${this.base}${path}`, {
      redirect,
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      await this.slots.penalizeUntil(this.clock.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 30_000));
      throw new NeardataHttpError(429, "neardata rate limited (429)");
    }
    return res;
  }

  async lastFinalHeight(): Promise<number> {
    const res = await this.call("/v0/last_block/final", "manual");
    const loc = res.headers.get("location") ?? "";
    const m = /\/v0\/block\/(\d+)/.exec(loc);
    if (!m)
      throw new NeardataHttpError(res.status, `last_block/final: no block redirect (status ${res.status})`);
    return Number(m[1]);
  }

  async getBlock(height: number): Promise<BlockAggregate | null> {
    const wire = await this.getWire(height);
    return wire === null ? null : aggregateBlock(wire, "final");
  }

  async getWire(height: number): Promise<unknown | null> {
    const res = await this.call(`/v0/block/${height}`, "follow");
    if (res.status === 404) return null;
    if (!res.ok) throw new NeardataHttpError(res.status, `block ${height}: HTTP ${res.status}`);
    const text = await res.text();
    if (text.trim() === "null") return null;
    return JSON.parse(text) as unknown;
  }
}
