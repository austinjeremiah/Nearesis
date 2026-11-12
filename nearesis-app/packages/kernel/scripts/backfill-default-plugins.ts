/**
 * Idempotent backfill: enables the default plugin set (NEARESIS_DEFAULT_PLUGINS, default near-thesis) at its active pinned
 * major in every workspace that has no workspace_plugins row for it. Workspaces where an admin disabled the plugin keep the
 * row and are NOT re-enabled. Audited per workspace. Usage: DATABASE_URL=<admin url> tsx packages/kernel/scripts/backfill-default-plugins.ts [--org <name>] [--dry]
 */
import pg from "pg";
import { DEFAULT_ADMIN_URL } from "../src/index.ts";
const url = process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL;
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dry = process.argv.includes("--dry");
const org = arg("--org");
const plugins = (process.env.NEARESIS_DEFAULT_PLUGINS ?? "near-thesis")
  .split(",")
  .map((x) => x.trim())
  .filter((x) => /^[a-z][a-z0-9-]{0,63}$/.test(x));

const pool = new pg.Pool({ connectionString: url, max: 1 });
const c = await pool.connect();
try {
  await c.query("BEGIN");
  await c.query("SET LOCAL search_path TO public");
  const report: Record<string, number> = {};
  for (const pluginId of plugins) {
    const inst = (
      await c.query("SELECT version, major, state FROM plugin_installations WHERE plugin_id=$1 AND active", [
        pluginId,
      ])
    ).rows[0];
    if (!inst || inst.state === "disabled" || inst.state === "quarantined") {
      report[`${pluginId}:skipped_not_installed`] = 1;
      continue;
    }
    const missing = (
      await c.query<{ id: string; org_id: string }>(
        `SELECT w.id, w.org_id FROM workspaces w
          WHERE NOT EXISTS (SELECT 1 FROM workspace_plugins wp WHERE wp.workspace_id = w.id AND wp.plugin_id = $1)
            AND ($2::text IS NULL OR w.org_id IN (SELECT id FROM organizations WHERE name = $2))`,
        [pluginId, org ?? null],
      )
    ).rows;
    for (const w of missing) {
      await c.query(
        "INSERT INTO workspace_plugins(workspace_id, org_id, plugin_id, pinned_major, enabled) VALUES ($1,$2,$3,$4,true) ON CONFLICT DO NOTHING",
        [w.id, w.org_id, pluginId, inst.major],
      );
      await c.query(
        `INSERT INTO audit_events(id, org_id, workspace_id, actor_id, action, subject, outcome, detail)
         VALUES (gen_random_uuid(), $1, $2, NULL, 'plugin.enabled_by_default', $3, 'ok', $4)`,
        [
          w.org_id,
          w.id,
          `plugin:${pluginId}`,
          JSON.stringify({ pluginId, version: inst.version, pinnedMajor: inst.major, reason: "backfill" }),
        ],
      );
    }
    report[`${pluginId}:enabled`] = missing.length;
  }
  await c.query(dry ? "ROLLBACK" : "COMMIT");
  console.log(JSON.stringify({ dry, org: org ?? "all", ...report }));
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  c.release();
  await pool.end();
}
