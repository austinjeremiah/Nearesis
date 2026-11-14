import type pg from "pg";
import { withTenant } from "./tenant.ts";

export type Guarantee = "internal" | "external_idempotent" | "external_non_idempotent";

export interface EffectSpec {
  tenantId: string;
  runId: string;
  effectKey: string;
  kind: string;
  guarantee: Guarantee;
}
export interface EffectOutcome<T> {
  result: T;
  /** true when the stored result of an earlier attempt was returned without calling the provider. */
  cached: boolean;
  /** true when this call's result was the one accepted into the ledger. */
  accepted: boolean;
}

/**
 * Side-effect ledger (A02, A18, A20 c). Effects insert `effect_key ... ON CONFLICT DO NOTHING RETURNING` first.
 * - Existing + done: stored result returned (exactly-once ACCEPTANCE).
 * - Existing + started (a crash hit inside the call window): the provider is called again (at-least-once DELIVERY),
 *   `provider_calls` is incremented before every call so duplicates are disclosed, and only the first result to finish
 *   is accepted (`UPDATE ... WHERE status <> 'done'`).
 */
export async function runExternalEffect<T>(
  pool: pg.Pool,
  spec: EffectSpec,
  call: () => Promise<T>,
  opts: { signal?: AbortSignal } = {},
): Promise<EffectOutcome<T>> {
  const state = await withTenant(pool, spec.tenantId, async (c) => {
    await c.query(
      `INSERT INTO agent_side_effects (effect_key, kind, run_id, tenant_id, guarantee)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (effect_key) DO NOTHING`,
      [spec.effectKey, spec.kind, spec.runId, spec.tenantId, spec.guarantee],
    );
    const r = await c.query<{ status: string; result: unknown }>(
      "SELECT status, result FROM agent_side_effects WHERE effect_key = $1 FOR UPDATE",
      [spec.effectKey],
    );
    const row = r.rows[0]!;
    if (row.status === "done") return { done: true as const, result: row.result as T };
    await c.query("UPDATE agent_side_effects SET provider_calls = provider_calls + 1 WHERE effect_key = $1", [
      spec.effectKey,
    ]);
    return { done: false as const };
  });
  if (state.done) return { result: state.result, cached: true, accepted: false };

  const raced = await raceAbort(call(), opts.signal);
  const accepted = await withTenant(pool, spec.tenantId, async (c) => {
    const u = await c.query(
      `UPDATE agent_side_effects SET status='done', result=$2::jsonb, accepted_at=now()
       WHERE effect_key=$1 AND status <> 'done' RETURNING effect_key`,
      [spec.effectKey, JSON.stringify(raced)],
    );
    if (u.rowCount) return { result: raced, accepted: true };
    const r = await c.query<{ result: T }>("SELECT result FROM agent_side_effects WHERE effect_key=$1", [
      spec.effectKey,
    ]);
    return { result: r.rows[0]!.result, accepted: false };
  });
  return { result: accepted.result, cached: false, accepted: accepted.accepted };
}

/** Internal (workspace DB) effect: key row and the write commit in one transaction => exactly once. */
export async function runInternalEffect<T>(
  pool: pg.Pool,
  spec: Omit<EffectSpec, "guarantee">,
  write: (c: pg.PoolClient) => Promise<T>,
): Promise<EffectOutcome<T>> {
  return withTenant(pool, spec.tenantId, async (c) => {
    const ins = await c.query(
      `INSERT INTO agent_side_effects (effect_key, kind, run_id, tenant_id, guarantee, provider_calls, status, accepted_at)
       VALUES ($1,$2,$3,$4,'internal',1,'done',now()) ON CONFLICT (effect_key) DO NOTHING RETURNING effect_key`,
      [spec.effectKey, spec.kind, spec.runId, spec.tenantId],
    );
    if (!ins.rowCount) {
      const r = await c.query<{ result: T }>("SELECT result FROM agent_side_effects WHERE effect_key=$1", [
        spec.effectKey,
      ]);
      return { result: r.rows[0]!.result, cached: true, accepted: false };
    }
    const result = await write(c);
    await c.query("UPDATE agent_side_effects SET result=$2::jsonb WHERE effect_key=$1", [
      spec.effectKey,
      JSON.stringify(result ?? null),
    ]);
    return { result, cached: false, accepted: true };
  });
}

export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(new AbortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
