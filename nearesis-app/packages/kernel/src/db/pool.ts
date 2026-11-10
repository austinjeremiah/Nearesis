import pg from "pg";
import type { PoolClient } from "pg";

export type Tx = PoolClient;

export interface TenantContext {
  orgId: string;
  userId: string;
  /** Server-resolved. 'agent' | 'service' principals rely on capability leases for further narrowing. */
  actorKind?: "human" | "agent" | "service";
}

export const DEFAULT_APP_URL = "postgres://nearesis_app:nearesis_app@127.0.0.1:55432/nearesis";
export const DEFAULT_ADMIN_URL = "postgres://nearesis:nearesis@127.0.0.1:55432/nearesis";

/** Thin pool wrapper. Every request-scoped unit of work runs in a transaction that first sets the tenant GUCs. */
export class Db {
  readonly pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.pool = pool;
  }
  static connect(url: string = process.env.DATABASE_APP_URL ?? DEFAULT_APP_URL, max = 10): Db {
    const pool = new pg.Pool({ connectionString: url, max });
    pool.on("error", () => undefined);
    return new Db(pool);
  }

  /** Tenant-scoped transaction (RLS applies). */
  async tx<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(fn, async (c) => {
      await c.query(
        "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_kind', $3, true)",
        [ctx.orgId, ctx.userId, ctx.actorKind ?? "human"],
      );
    });
  }

  /** Transaction with no tenant context: only platform-global tables and definer functions are usable. */
  async txGlobal<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(fn);
  }

  private async run<T>(fn: (tx: Tx) => Promise<T>, setup?: (c: Tx) => Promise<void>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      if (setup) await setup(c);
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      try {
        await c.query("ROLLBACK");
      } catch {
        /* connection is gone; release below discards it */
      }
      throw e;
    } finally {
      c.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
