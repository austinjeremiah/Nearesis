/**
 * `pnpm dev:seed` - idempotent dev data for sign-in through the web app's "Sign in (dev)" button.
 *
 * Creates (or finds) in the dev database: org "Nearesis Dev", user dev@nearesis.local (oidc subject `dev-owner`, role
 * owner) and one workspace "NEAR Intents research", enables the near-thesis plugin in it when that plugin is installed,
 * and prints the workspace URL. Org, user and membership have no kernel helper outside tests, so they are plain upserts
 * through the admin connection; the workspace and the plugin enablement go through the kernel (create with a fixed
 * idempotency key, `plugin.enable` command). Safe to run repeatedly. Never prints secrets.
 *
 * Env: DATABASE_URL (admin, default dev), DATABASE_APP_URL (app role, default dev), NEARESIS_PLUGIN_TRUSTED_KEYS,
 * NEARESIS_PLUGIN_ROOT, NEARESIS_WEB_URL (default http://127.0.0.1:3300).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ADMIN_URL,
  DEFAULT_APP_URL,
  DEFAULT_ENGINE_INTERFACES,
  Db,
  Kernel,
  loadTrustedKeys,
  migrate as migrateKernel,
} from "../../packages/kernel/src/index.ts";
import { makePool, migrate as migrateRuntime } from "../../packages/workflow/src/db.ts";

const here = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(here, "..", "..");

function loadEnv(): void {
  const p = join(APP_ROOT, "..", ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

export const DEV = {
  org: "Nearesis Dev",
  email: "dev@nearesis.local",
  subject: "dev-owner",
  objective: "NEAR Intents research",
  idempotencyKey: "dev-seed:near-intents-research",
} as const;

export async function seed(o: { adminUrl: string; appUrl: string; webUrl: string }) {
  await migrateKernel(o.adminUrl);
  const admin = makePool(o.adminUrl, 1);
  try {
    await migrateRuntime(admin);
    // makePool pins search_path=runtime; the single pooled connection is switched to the kernel tables in public.
    await admin.query("SET search_path TO public");
    let orgId = (
      await admin.query<{ id: string }>("SELECT id FROM organizations WHERE name = $1 ORDER BY id LIMIT 1", [
        DEV.org,
      ])
    ).rows[0]?.id;
    if (!orgId) {
      orgId = randomUUID();
      await admin.query("INSERT INTO organizations(id, name) VALUES ($1,$2)", [orgId, DEV.org]);
    }
    const userId = (
      await admin.query<{ id: string }>(
        `INSERT INTO users(id, oidc_subject, display_name) VALUES ($1,$2,$3)
         ON CONFLICT (oidc_subject) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
        [randomUUID(), DEV.subject, DEV.email],
      )
    ).rows[0]!.id;
    await admin.query(
      `INSERT INTO memberships(org_id, user_id, role) VALUES ($1,$2,'owner')
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'owner'`,
      [orgId, userId],
    );

    const kernel = new Kernel({
      db: Db.connect(o.appUrl, 4),
      plugins: {
        trustMode: "production",
        trustedKeys: loadTrustedKeys(),
        pluginRoot: process.env.NEARESIS_PLUGIN_ROOT ?? join(APP_ROOT, "plugins", "near-thesis"),
        engineInterfaces: DEFAULT_ENGINE_INTERFACES,
      },
      nodeEnv: "development",
    });
    try {
      const session = await kernel.identity.resolveSession(await kernel.devAuth!.login(DEV.subject));
      const ws = await kernel.workspaces.create(session, {
        objective: DEV.objective,
        networkScope: "fixture-only",
        idempotencyKey: DEV.idempotencyKey,
      });
      let pluginEnabled = false;
      const installed = await admin.query(
        "SELECT 1 FROM plugin_installations WHERE plugin_id = 'near-thesis' AND active LIMIT 1",
      );
      if (installed.rowCount) {
        const on = await admin.query(
          "SELECT 1 FROM workspace_plugins WHERE workspace_id = $1 AND plugin_id = 'near-thesis' AND enabled",
          [ws.workspaceId],
        );
        if (!on.rowCount) {
          await kernel.boot();
          const cur = await kernel.workspaces.get(session, ws.workspaceId);
          await kernel.commands.execute(session, ws.workspaceId, {
            apiVersion: "v1",
            commandId: randomUUID(),
            commandType: "plugin.enable",
            payload: { pluginId: "near-thesis" },
            expectedVersion: cur.version,
          });
        }
        pluginEnabled = true;
      }
      const url = `${o.webUrl.replace(/\/$/, "")}/w/${ws.workspaceId}?backend=kernel&data=semantic`;
      return { orgId, userId, workspaceId: ws.workspaceId, pluginEnabled, url };
    } finally {
      await kernel.close();
    }
  } finally {
    await admin.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  loadEnv();
  const r = await seed({
    adminUrl: process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL,
    appUrl: process.env.DATABASE_APP_URL ?? DEFAULT_APP_URL,
    webUrl: process.env.NEARESIS_WEB_URL ?? "http://127.0.0.1:3300",
  });
  console.log(`org ${r.orgId}\nuser ${DEV.email} (subject ${DEV.subject}, owner)`);
  console.log(
    `workspace ${r.workspaceId} (${DEV.objective})${r.pluginEnabled ? "" : " - near-thesis plugin not installed, questions will not run until it is"}`,
  );
  console.log(`open: ${r.url}`);
}
