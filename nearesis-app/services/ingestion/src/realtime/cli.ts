import { parseArgs } from "node:util";
import { Redis } from "ioredis";
import { createLiveCh, ensureDatabase, migrateLive } from "../backfill/ch.ts";
import { REDIS_URL } from "../backfill/env.ts";
import { systemClock } from "../clock.ts";
import { RedisLease, RedisTokenBucket } from "../rate/limiter.ts";
import { RT_FEED_ID } from "./aggregate.ts";
import { RealtimeFeed } from "./feed.ts";
import { NEARDATA_INTERVAL_MS, NEARDATA_RATE_KEY, NeardataClient } from "./neardata.ts";
import { DEFAULT_RPC_URL, RPC_INTERVAL_MS, RpcBlockSource, rpcRateKey } from "./rpc.ts";
import { reconcileDays } from "./reconcile.ts";
import { ClickHouseRtStore, type MinuteRow } from "./store.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  allowPositionals: true,
  options: {
    "max-minutes": { type: "string" }, // bounded run (test runs); 0/absent = until SIGTERM
    "no-migrate": { type: "boolean" },
    "with-receipts": { type: "boolean" }, // RPC mode: also count receipts (11 calls/block; falls behind real time on free limits)
    source: { type: "string" }, // rpc (default) | neardata (rate limited to ~0.5 req/s from one IP: cannot keep pace)
  },
});
const cmd = positionals[0] ?? "run";
const log = (m: string): void => console.log(`[${new Date().toISOString()}] realtime: ${m}`);

await ensureDatabase();
const ch = createLiveCh();
if (!values["no-migrate"]) await migrateLive(ch);
const store = new ClickHouseRtStore(ch);

if (cmd === "reconcile") {
  const r = await reconcileDays(ch, Date.now());
  console.log(JSON.stringify(r, null, 2));
  await ch.close();
  process.exit(0);
}
if (cmd === "status") {
  console.log(JSON.stringify(await store.getWatermark(), null, 2));
  await ch.close();
  process.exit(0);
}

const redis = new Redis(REDIS_URL);
const rpcUrl = process.env.NEARESIS_RT_RPC_URL ?? DEFAULT_RPC_URL;
const useNeardata = values.source === "neardata";
const bucket = useNeardata
  ? new RedisTokenBucket(redis, NEARDATA_RATE_KEY, systemClock, NEARDATA_INTERVAL_MS)
  : new RedisTokenBucket(redis, rpcRateKey(rpcUrl), systemClock, RPC_INTERVAL_MS);
// one feed per chain: a lease keeps a second process from double-feeding (dedupe makes it harmless, the lease makes it cheap)
const lease = new RedisLease(redis, "ingestion:lease:realtime", 60_000);
if (!(await lease.acquire())) {
  log("another realtime instance holds the lease; exiting 3");
  redis.disconnect();
  await ch.close();
  process.exit(3);
}
const renew = setInterval(
  () => void redis.pexpire("ingestion:lease:realtime", 60_000).catch(() => undefined),
  20_000,
);

const client = useNeardata
  ? new NeardataClient(bucket, systemClock)
  : new RpcBlockSource(bucket, systemClock, rpcUrl, fetch, 20_000, values["with-receipts"] === true);
/** Per-closed-minute freshness record for the existing monitor/coverage plumbing (one row per minute, never per block). */
const onMinute = async (m: MinuteRow): Promise<void> => {
  const t = new Date(m.minuteMs + 60_000).toISOString().replace("T", " ").replace("Z", "");
  await ch
    .insert({
      table: "source_watermarks",
      format: "JSONEachRow",
      values: [
        {
          provider_id: "near-realtime",
          newest_event_time: t,
          last_full_scan_at: null,
          gap_count: 0,
          provider_lag_seconds: null,
          schema_version: "rt-1",
          state: "live",
          version: Date.now(),
        },
      ],
    })
    .catch(() => undefined);
};
const feed = new RealtimeFeed(client, store, systemClock, log, onMinute, { prefetch: 12 });
const maxMin = Number(values["max-minutes"] ?? 0);
const deadline = maxMin > 0 ? Date.now() + maxMin * 60_000 : Infinity;
const stop = (): void => void (feed.stopped = true);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
let code = 0;
try {
  log(`start feed=${RT_FEED_ID} max-minutes=${maxMin || "unbounded"}`);
  await feed.run(() => Date.now() >= deadline);
  log(`stopped: ${feed.blocksIngested} blocks, ${client.requests} requests`);
} catch (e) {
  log(`fatal: ${(e as Error).message}`);
  code = 1;
} finally {
  clearInterval(renew);
  await lease.release().catch(() => undefined);
  redis.disconnect();
  await ch.close().catch(() => undefined);
}
process.exit(code);
