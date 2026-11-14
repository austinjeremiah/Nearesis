/**
 * One competing scheduler worker for M13, run as a real OS process (`node --import tsx m13-worker.ts`).
 * Env: DATABASE_APP_URL, WORKER_ID, LEASE_MS, EVENTS_FILE (JSON array of watermark events this worker emits, shuffled).
 * It emits its events into the inbox (idempotent), evaluates every third one directly (racing the lease holder on the
 * identical event), and ticks as the lease holder consumes the inbox. Stops on SIGTERM; SIGKILL is the crash.
 */
import { readFileSync } from "node:fs";
import { Db } from "../../src/db/pool.ts";
import { EventJournal } from "../../src/journal.ts";
import { MonitorScheduler } from "../../src/monitoring/scheduler.ts";

const id = process.env.WORKER_ID ?? "w";
const sched = new MonitorScheduler(Db.connect(process.env.DATABASE_APP_URL, 4), new EventJournal(), {
  holder: id,
  leaseMs: Number(process.env.LEASE_MS ?? 3000),
  batch: 10,
});
const events = JSON.parse(readFileSync(process.env.EVENTS_FILE!, "utf8")) as Array<{
  sourceId: string;
  watermark: string;
  mode: "live";
  values: Record<string, number>;
}>;
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ticker = (async () => {
  while (!stopping) {
    await sched.tick().catch(() => undefined);
    await sleep(150);
  }
})();
console.log("READY");
let n = 0;
for (const e of events) {
  if (stopping) break;
  await sched.enqueue(e).catch(() => undefined);
  if (n++ % 3 === Number(process.env.SLOT ?? 0)) await sched.processEvent(e).catch(() => undefined);
  await sleep(Number(process.env.EMIT_GAP_MS ?? 40));
}
console.log("EMITTED");
await ticker;
await sched.stop();
process.exit(0);
