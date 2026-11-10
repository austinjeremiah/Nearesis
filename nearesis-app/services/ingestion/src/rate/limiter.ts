import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Clock } from "../clock.ts";

export const EXPLORER_INTERVAL_MS = 5000;

/** Token bucket with capacity 1 and refill 1/intervalMs, kept as `next allowed time`, updated atomically in Lua. */
const ACQUIRE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local nextAllowed = tonumber(redis.call('GET', key) or '0')
if now >= nextAllowed then
  redis.call('SET', key, now + interval, 'PX', interval * 4 + 60000)
  return 0
end
return nextAllowed - now
`;
/** Push the next allowed time out (429 / Retry-After). Never moves it earlier. */
const PENALIZE_LUA = `
local key = KEYS[1]
local target = tonumber(ARGV[1])
local cur = tonumber(redis.call('GET', key) or '0')
if target > cur then redis.call('SET', key, target, 'PX', tonumber(ARGV[2])) return target end
return cur
`;

export const credentialRateKey = (provider: string, credential: string): string =>
  `ingestion:rate:${provider}:${createHash("sha256").update(credential).digest("hex").slice(0, 16)}`;

export class RedisTokenBucket {
  constructor(
    private readonly redis: Redis,
    readonly key: string,
    private readonly clock: Clock,
    private readonly intervalMs: number = EXPLORER_INTERVAL_MS,
  ) {}

  /** Milliseconds to wait before a request may be made; 0 means the slot was taken now. */
  async tryAcquire(): Promise<number> {
    return (await this.attempt()).wait;
  }

  /**
   * Blocks (via the clock) until a slot is granted. Returns the slot time that was recorded atomically in Redis
   * (the `now` the grant was decided on), not a later clock read, so successive grants are always >= intervalMs apart
   * regardless of timer or scheduling latency between the Redis round trip and the caller resuming.
   */
  async acquire(): Promise<number> {
    for (;;) {
      const { wait, now } = await this.attempt();
      if (wait === 0) return now;
      await this.clock.sleep(wait);
    }
  }

  private async attempt(): Promise<{ wait: number; now: number }> {
    const now = this.clock.now();
    const wait = Number(
      await this.redis.eval(ACQUIRE_LUA, 1, this.key, String(now), String(this.intervalMs)),
    );
    return { wait, now };
  }

  async penalizeUntil(epochMs: number): Promise<void> {
    await this.redis.eval(
      PENALIZE_LUA,
      1,
      this.key,
      String(epochMs),
      String(Math.max(60_000, epochMs - this.clock.now() + 60_000)),
    );
  }
}

/** Single-scheduler lease: SET NX PX with an owner token; release only if still owner. */
const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
export class RedisLease {
  readonly token = randomUUID();
  constructor(
    private readonly redis: Redis,
    readonly key: string,
    private readonly ttlMs: number = 60_000,
  ) {}
  async acquire(): Promise<boolean> {
    return (await this.redis.set(this.key, this.token, "PX", this.ttlMs, "NX")) === "OK";
  }
  async release(): Promise<void> {
    await this.redis.eval(RELEASE_LUA, 1, this.key, this.token);
  }
}
