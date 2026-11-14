import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

/** Creates the checkpointer tables in schema `runtime` (as admin) and grants the app role access. */
export async function setupCheckpointer(adminUrl: string): Promise<void> {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query("CREATE SCHEMA IF NOT EXISTS runtime");
    const saver = PostgresSaver.fromConnString(adminUrl, { schema: "runtime" });
    await saver.setup();
    await saver.end();
    await admin.query("GRANT USAGE ON SCHEMA runtime TO nearesis_app");
    await admin.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON runtime.checkpoints, runtime.checkpoint_blobs, runtime.checkpoint_writes, runtime.checkpoint_migrations TO nearesis_app",
    );
  } finally {
    await admin.end();
  }
}

/** Postgres-backed LangGraph checkpointer (thread id = task id). Caller must `end()` it. */
export function openCheckpointer(appUrl: string): PostgresSaver {
  // `fromConnString` builds a pool nobody can attach an error listener to: a database restart or connection reset then
  // surfaces as an unhandled 'error' event and kills the worker (found by PERF11). Own the pool so the error is handled.
  const pool = new pg.Pool({ connectionString: appUrl });
  pool.on("error", () => undefined);
  // checked-out clients between statements (LangGraph holds one across a put) emit on the client itself
  pool.on("connect", (c) => c.on("error", () => undefined));
  return new PostgresSaver(pool as never, undefined, { schema: "runtime" });
}
export type { PostgresSaver };
