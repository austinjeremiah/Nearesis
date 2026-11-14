/**
 * Side-effect pipeline for PERF11: one job = one idempotent paid API call + one mock chain write, executed through the
 * production side-effect ledger (`runExternalEffect`, A02/A18/A20). The chain write resolves a pending broadcast by
 * LOOKUP before it would rebroadcast (ch.13 "a pending write resolves by querying before rebroadcast").
 * `naive` mode is the negative control: it retries a failed attempt with a fresh idempotency key and rebroadcasts
 * without lookup, which is what a worker without idempotency keys does.
 */
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { runExternalEffect } from "../../packages/agent-runtime/src/ledger.ts";
import { withTenant } from "../../packages/agent-runtime/src/tenant.ts";

export const FX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runtime.fx_jobs (
  job_id text PRIMARY KEY, tenant_id uuid NOT NULL, run_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued', lease_until timestamptz, attempts int NOT NULL DEFAULT 0, worker text
);
GRANT SELECT, INSERT, UPDATE ON runtime.fx_jobs TO nearesis_app;`;

export const txHashFor = (jobId: string) =>
  createHash("sha256").update(`tx:${jobId}`).digest("hex").slice(0, 32);
export const paidKeyFor = (jobId: string) => `paid:${jobId}`;

export interface Job {
  job_id: string;
  tenant_id: string;
  run_id: string;
}

export async function processJob(
  pool: pg.Pool,
  job: Job,
  providerUrl: string,
  mode: "idempotent" | "naive",
  hooks: { afterPaidSent?: () => void; afterChainSent?: () => void } = {},
): Promise<void> {
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${providerUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  };
  const spec = (kind: string, guarantee: "external_idempotent" | "external_non_idempotent") => ({
    tenantId: job.tenant_id,
    runId: job.run_id,
    effectKey: `fx:${job.job_id}:${kind}${mode === "naive" ? `:${randomUUID()}` : ""}`,
    kind,
    guarantee,
  });
  // 1. paid external call (idempotent by key at the provider)
  const key = mode === "naive" ? `paid:${job.job_id}:${randomUUID()}` : paidKeyFor(job.job_id);
  await runExternalEffect(pool, spec("paid_api", "external_idempotent"), async () => {
    const r = await post("/paid", { idempotencyKey: key });
    hooks.afterPaidSent?.(); // fault injection point: the process dies after the provider accepted, before the ledger knows
    return r;
  });
  // 2. mock chain write: look up before (re)broadcasting
  const hash = txHashFor(job.job_id);
  await runExternalEffect(pool, spec("chain_write", "external_non_idempotent"), async () => {
    if (mode === "idempotent") {
      const found = await fetch(`${providerUrl}/tx/${hash}`);
      if (found.ok) return { txHash: hash, resolvedByLookup: true };
    }
    await post("/broadcast", { txHash: hash });
    hooks.afterChainSent?.();
    return { txHash: hash, resolvedByLookup: false };
  });
}

export async function seedJobs(admin: pg.Pool, tenantId: string, ids: string[]): Promise<Job[]> {
  const jobs = ids.map((id) => ({ job_id: id, tenant_id: tenantId, run_id: randomUUID() }));
  await admin.query(FX_SCHEMA_SQL);
  for (const j of jobs)
    await admin.query("INSERT INTO runtime.fx_jobs (job_id, tenant_id, run_id) VALUES ($1,$2,$3)", [
      j.job_id,
      j.tenant_id,
      j.run_id,
    ]);
  return jobs;
}

/** Claims one job whose lease is free or expired (a killed worker's job is reclaimed once its lease runs out). */
export async function claimJob(
  pool: pg.Pool,
  tenantId: string,
  worker: string,
  leaseMs: number,
): Promise<Job | null> {
  return withTenant(pool, tenantId, async (c) => {
    const r = await c.query(
      `UPDATE fx_jobs SET state='running', worker=$2, attempts=attempts+1, lease_until = now() + ($3 || ' milliseconds')::interval
        WHERE job_id = (SELECT job_id FROM fx_jobs WHERE tenant_id=$1 AND state <> 'done' AND (lease_until IS NULL OR lease_until < now())
                         ORDER BY job_id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING job_id, tenant_id, run_id`,
      [tenantId, worker, String(leaseMs)],
    );
    return (r.rows[0] as Job | undefined) ?? null;
  });
}
export async function finishJob(pool: pg.Pool, tenantId: string, jobId: string): Promise<void> {
  await withTenant(pool, tenantId, (c) =>
    c.query("UPDATE fx_jobs SET state='done', lease_until=NULL WHERE job_id=$1", [jobId]),
  );
}
