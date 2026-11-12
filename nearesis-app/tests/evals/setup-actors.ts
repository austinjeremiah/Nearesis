/**
 * `pnpm evals:setup` - idempotent dev actors for the permission and tenant-safety questions. Plain upserts through the admin
 * connection, exactly like scripts/dev/seed.ts: a viewer in the dev org (`eval-viewer`) and a second organisation with its own
 * owner (`eval-other-owner`). Adds rows only; never edits or removes existing ones. Never prints secrets.
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_ADMIN_URL } from "../../packages/kernel/src/index.ts";
import { makePool } from "../../packages/workflow/src/db.ts";

const DEV_ORG = "Nearesis Dev";
const OTHER_ORG = "Nearesis Evals Other Tenant";

const pool = makePool(process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL, 1);
try {
  await pool.query("SET search_path TO public");
  const orgId = async (name: string): Promise<string> => {
    const f = (
      await pool.query<{ id: string }>("SELECT id FROM organizations WHERE name=$1 ORDER BY id LIMIT 1", [
        name,
      ])
    ).rows[0]?.id;
    if (f) return f;
    const id = randomUUID();
    await pool.query("INSERT INTO organizations(id, name) VALUES ($1,$2)", [id, name]);
    return id;
  };
  const member = async (org: string, subject: string, role: string): Promise<void> => {
    const u = (
      await pool.query<{ id: string }>(
        `INSERT INTO users(id, oidc_subject, display_name) VALUES ($1,$2,$3)
         ON CONFLICT (oidc_subject) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
        [randomUUID(), subject, `${subject}@nearesis.local`],
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO memberships(org_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (org_id, user_id) DO NOTHING`,
      [org, u, role],
    );
  };
  await member(await orgId(DEV_ORG), "eval-viewer", "viewer");
  await member(await orgId(OTHER_ORG), "eval-other-owner", "owner");
  console.log("eval actors ready: eval-viewer (viewer, dev org), eval-other-owner (owner, separate org)");
} finally {
  await pool.end();
}
