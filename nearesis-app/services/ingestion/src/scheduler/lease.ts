import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

const RENEW_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

/** Single-instance lease: SET NX PX with an owner token, renewable and released only by the owner. */
export class SchedulerLease {
  readonly token = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  lost = false;
  constructor(
    private readonly redis: Redis,
    readonly key: string,
    private readonly ttlMs: number = 120_000,
  ) {}
  async acquire(): Promise<boolean> {
    return (await this.redis.set(this.key, this.token, "PX", this.ttlMs, "NX")) === "OK";
  }
  async renew(): Promise<boolean> {
    return Number(await this.redis.eval(RENEW_LUA, 1, this.key, this.token, String(this.ttlMs))) === 1;
  }
  /** Renews at a third of the TTL; `lost` flips if another owner took over (the loop must then stop). */
  startRenewing(): void {
    this.timer = setInterval(
      () => {
        this.renew().then(
          (ok) => {
            if (!ok) this.lost = true;
          },
          () => undefined,
        );
      },
      Math.floor(this.ttlMs / 3),
    );
    this.timer.unref();
  }
  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.redis.eval(RELEASE_LUA, 1, this.key, this.token);
  }
}
