import type { SpendGate } from "@nearesis/contracts";

/**
 * Process-wide spend gate for the ingestion CLIs (backfill, scheduler, account phase, registry refresh). The CLI
 * installs it once at startup; `HttpClient`, `createBigQueryClient` and `openArchive` pick it up, so every provider
 * call and raw-archive write of the process is covered without threading a parameter through each constructor.
 * Absent (the default, and whenever NEARESIS_COST_CONTROL is not "1") nothing changes.
 */
let ambient: SpendGate | undefined;
export const getAmbientSpendGate = (): SpendGate | undefined => ambient;
export const setAmbientSpendGate = (g: SpendGate | undefined): void => {
  ambient = g;
};

/**
 * NEARESIS_COST_CONTROL=1: builds a CostGovernor on the app-role pool (DATABASE_APP_URL; runtime migration 005 must be
 * applied) scoped to NEARESIS_COST_TENANT_ID / NEARESIS_COST_WORKSPACE_ID, and installs it. Fails closed when the scope
 * is missing. Returns a closer for the pool.
 */
export async function installSpendGateFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ gate: SpendGate; close: () => Promise<void> } | undefined> {
  if (env.NEARESIS_COST_CONTROL !== "1") return undefined;
  const rt = await import("@nearesis/agent-runtime");
  const pg = (await import("pg")).default;
  const scope = rt.spendScopeFromEnv(env);
  const pool = new pg.Pool({
    connectionString: env.DATABASE_APP_URL ?? "postgres://nearesis_app:nearesis_app@127.0.0.1:55432/nearesis",
    max: 4,
    options: "-c search_path=runtime",
  });
  pool.on("error", () => undefined);
  const gate = rt.scopedSpendGate(new rt.CostGovernor({ pool }), scope);
  setAmbientSpendGate(gate);
  return { gate, close: () => pool.end() };
}
