import type pg from "pg";

/** Transaction with the tenant GUC set so RLS applies (`app.org_id`). Pools must use search_path=runtime. */
export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  // A restart or reset while the client is checked out is an 'error' event on it; unhandled that kills the process.
  const onClientError = () => undefined;
  c.on("error", onClientError);
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.org_id', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.removeListener("error", onClientError);
    c.release();
  }
}
