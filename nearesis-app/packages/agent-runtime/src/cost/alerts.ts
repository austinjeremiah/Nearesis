import type pg from "pg";
import { withTenant } from "../tenant.ts";
import type { AlertPayload, AlertSink, Querier } from "./types.ts";

export interface AlertCaps {
  maxPerWindow: number;
  windowSeconds: number;
  cooldownSeconds: number;
}
export interface EmitResult {
  status: "sent" | "suppressed";
  reason?: "duplicate" | "cooldown" | "window_cap";
}

/**
 * Alert frequency cap (ch.13 "alert noise"): an alert is recorded for every trigger; it is SENT only when
 *  1. the same key was not already sent inside the window (duplicate),
 *  2. no alert of the same kind for the scope was sent inside the cooldown (cooldown), and
 *  3. fewer than `maxPerWindow` alerts for the scope were sent inside the window (window_cap).
 * Everything else is stored as `suppressed` with its reason so counts reconcile (sent + suppressed = triggers).
 * Serialised per scope with an advisory lock so concurrent triggers cannot overshoot the cap.
 */
export async function decideAlert(
  q: Querier,
  a: AlertPayload,
  caps: AlertCaps,
  now: Date,
): Promise<EmitResult> {
  const scope = `${a.tenantId ?? "platform"}:${a.workspaceId ?? "-"}`;
  await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ops-alert:${scope}`]);
  const since = new Date(now.getTime() - caps.windowSeconds * 1000).toISOString();
  const cool = new Date(now.getTime() - caps.cooldownSeconds * 1000).toISOString();
  const scopeSql = "tenant_id IS NOT DISTINCT FROM $1::uuid AND workspace_id IS NOT DISTINCT FROM $2::uuid";
  const dup = await q.query(
    `SELECT 1 FROM runtime.ops_alerts WHERE ${scopeSql} AND alert_key = $3 AND status='sent' AND created_at >= $4 LIMIT 1`,
    [a.tenantId, a.workspaceId, a.key, since],
  );
  let result: EmitResult;
  if (dup.rowCount) result = { status: "suppressed", reason: "duplicate" };
  else {
    const cd = await q.query(
      `SELECT 1 FROM runtime.ops_alerts WHERE ${scopeSql} AND kind = $3 AND status='sent' AND created_at >= $4 LIMIT 1`,
      [a.tenantId, a.workspaceId, a.kind, cool],
    );
    if (cd.rowCount && caps.cooldownSeconds > 0) result = { status: "suppressed", reason: "cooldown" };
    else {
      const n = await q.query(
        `SELECT count(*)::int AS n FROM runtime.ops_alerts WHERE ${scopeSql} AND status='sent' AND created_at >= $3`,
        [a.tenantId, a.workspaceId, since],
      );
      result =
        (n.rows[0]!.n as number) >= caps.maxPerWindow
          ? { status: "suppressed", reason: "window_cap" }
          : { status: "sent" };
    }
  }
  await q.query(
    `INSERT INTO runtime.ops_alerts (tenant_id, workspace_id, alert_key, kind, severity, status, suppressed_reason, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      a.tenantId,
      a.workspaceId,
      a.key,
      a.kind,
      a.severity,
      result.status,
      result.reason ?? null,
      JSON.stringify({ title: a.title, ...a.detail }),
      now.toISOString(),
    ],
  );
  return result;
}

/** Records the trigger, applies the cap and, when sent, delivers through the sink (after the decision commits). */
export async function emitAlert(
  pool: pg.Pool,
  sink: AlertSink | undefined,
  a: AlertPayload,
  caps: AlertCaps,
  now: Date,
): Promise<EmitResult> {
  const run = (c: pg.PoolClient) => decideAlert(c, a, caps, now);
  const r = a.tenantId
    ? await withTenant(pool, a.tenantId, run)
    : await (async () => {
        const c = await pool.connect();
        const onClientError = () => undefined; // a reset between statements must reject, not crash
        c.on("error", onClientError);
        try {
          await c.query("BEGIN");
          const out = await run(c);
          await c.query("COMMIT");
          return out;
        } catch (e) {
          await c.query("ROLLBACK").catch(() => undefined);
          throw e;
        } finally {
          c.removeListener("error", onClientError);
          c.release();
        }
      })();
  if (r.status === "sent" && sink) await sink.send(a);
  return r;
}
