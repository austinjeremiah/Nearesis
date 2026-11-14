import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { trackLease, untrackLease } from "../rate/shutdown.ts";

const RENEW_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export type LeaseEvent = "clock_jump" | "reacquired" | "lost" | "renew_error";

/** Single-instance lease: SET NX PX with an owner token, renewable and released only by the owner. */
export class SchedulerLease {
  readonly token = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private lastBeatMs: number;
  lost = false;
  /** Number of detected clock jumps (machine sleep) and successful re-acquisitions, for status and tests. */
  clockJumps = 0;
  reacquisitions = 0;
  constructor(
    private readonly redis: Redis,
    readonly key: string,
    private readonly ttlMs: number = 120_000,
    private readonly opts: { now?: () => number; onEvent?: (e: LeaseEvent) => void } = {},
  ) {
    this.lastBeatMs = this.now();
  }
  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
  async acquire(): Promise<boolean> {
    const ok = (await this.redis.set(this.key, this.token, "PX", this.ttlMs, "NX")) === "OK";
    if (ok) trackLease(this);
    return ok;
  }
  async renew(): Promise<boolean> {
    return Number(await this.redis.eval(RENEW_LUA, 1, this.key, this.token, String(this.ttlMs))) === 1;
  }
  /**
   * One renewal heartbeat. A gap far longer than the interval means the machine slept: the key may have expired in the
   * meantime, so a failed renew is followed by a re-acquire (SET NX). Only when another owner really holds the key is
   * the lease `lost`; a key that merely expired during sleep is taken back, and the loop carries on.
   */
  async beat(intervalMs: number = Math.floor(this.ttlMs / 3)): Promise<void> {
    const t = this.now();
    if (t - this.lastBeatMs > intervalMs * 2) {
      this.clockJumps++;
      this.opts.onEvent?.("clock_jump");
    }
    this.lastBeatMs = t;
    try {
      if (await this.renew()) return;
      if (await this.acquire()) {
        this.reacquisitions++;
        this.opts.onEvent?.("reacquired");
        return;
      }
      this.lost = true;
      this.opts.onEvent?.("lost");
    } catch {
      // Redis unreachable (e.g. just after wake): keep the loop alive, the next beat retries.
      this.opts.onEvent?.("renew_error");
    }
  }
  /** Renews at a third of the TTL; `lost` flips only if another owner took over (the loop must then stop). */
  startRenewing(): void {
    const every = Math.floor(this.ttlMs / 3);
    this.timer = setInterval(() => void this.beat(every), every);
    this.timer.unref();
  }
  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    untrackLease(this);
    await this.redis.eval(RELEASE_LUA, 1, this.key, this.token);
  }
}
