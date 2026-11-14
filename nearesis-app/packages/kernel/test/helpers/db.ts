import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { Db, DEFAULT_ADMIN_URL, migrate } from "../../src/index.ts";

const ADMIN_URL = process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL;

export interface TestDb {
  name: string;
  /** nearesis_app (NOBYPASSRLS) - what the kernel uses. */
  app: Db;
  /** superuser, for seeding and ground-truth reads. */
  admin: pg.Pool;
  appUrl: string;
  adminUrl: string;
  drop(): Promise<void>;
}

function withDb(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Create a disposable database nearesis_t_a2_<random>, migrate it, and return app + admin handles. */
export async function createTestDb(): Promise<TestDb> {
  const name = `nearesis_t_a2_${randomBytes(5).toString("hex")}`;
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${name}`);
  } finally {
    await root.end();
  }
  const adminUrl = withDb(ADMIN_URL, name);
  await migrate(adminUrl);
  const appBase = new URL(
    process.env.DATABASE_APP_URL ?? "postgres://nearesis_app:nearesis_app@127.0.0.1:55432/nearesis",
  );
  const appUrl = withDb(appBase.toString(), name);
  const admin = new pg.Pool({ connectionString: adminUrl, max: 4 });
  admin.on("error", () => undefined);
  const app = Db.connect(appUrl, 8);
  return {
    name,
    app,
    admin,
    appUrl,
    adminUrl,
    async drop() {
      await app.close();
      await admin.end();
      const r = new pg.Client({ connectionString: ADMIN_URL });
      await r.connect();
      try {
        await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await r.end();
      }
    },
  };
}

export interface SeededOrg {
  orgId: string;
  users: Record<string, { userId: string; subject: string }>;
}

/** Seed an org with users (name -> role). Subjects are unique per call. */
export async function seedOrg(
  admin: pg.Pool,
  orgName: string,
  members: Record<string, "owner" | "admin" | "analyst" | "viewer">,
): Promise<SeededOrg> {
  const orgId = randomUUID();
  await admin.query("INSERT INTO organizations(id, name) VALUES ($1,$2)", [orgId, orgName]);
  const users: SeededOrg["users"] = {};
  for (const [name, role] of Object.entries(members)) {
    const userId = randomUUID();
    const subject = `${orgName}.${name}.${randomBytes(3).toString("hex")}`;
    await admin.query("INSERT INTO users(id, oidc_subject, display_name) VALUES ($1,$2,$3)", [
      userId,
      subject,
      name,
    ]);
    await admin.query("INSERT INTO memberships(org_id, user_id, role) VALUES ($1,$2,$3)", [
      orgId,
      userId,
      role,
    ]);
    users[name] = { userId, subject };
  }
  return { orgId, users };
}
