/** PERF11 effect worker process (SIGKILL target). Env: FX_DB_URL, FX_TENANT, FX_PROVIDER, FX_WORKER, FX_LEASE_MS. */
import { makePool } from "../../packages/workflow/src/db.ts";
import { claimJob, finishJob, processJob } from "./_chaos-fx.ts";

const pool = makePool(process.env.FX_DB_URL!, 4);
pool.on("error", () => undefined);
const tenant = process.env.FX_TENANT!;
const worker = process.env.FX_WORKER ?? `fx-${process.pid}`;
console.log(`READY ${worker}`);
let idle = 0;
for (;;) {
  try {
    const job = await claimJob(pool, tenant, worker, Number(process.env.FX_LEASE_MS ?? 3000));
    if (!job) {
      if (++idle > 400) break; // 2 minutes without work
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    idle = 0;
    await processJob(pool, job, process.env.FX_PROVIDER!, "idempotent");
    await finishJob(pool, tenant, job.job_id);
  } catch {
    await new Promise((r) => setTimeout(r, 500)); // infrastructure fault: back off and retry the claim
  }
}
await pool.end();
