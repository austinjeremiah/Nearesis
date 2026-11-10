/**
 * Real-kernel integration environment: one disposable database holding the kernel tables (schema public) AND the
 * runtime tables (schema runtime), a booted Kernel with production plugin trust (signed manifests, a per-run deployer
 * key registered as the trusted publisher), the near-thesis plugin (semantic.query/discover, canvas.preview) and a
 * role-tools fixture plugin that serves the remaining catalog capabilities. Used by A03, A11, A19, A20 and the
 * workflow acceptance harness. Never imported by production code.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import pg from "pg";
import {
  DEFAULT_ENGINE_INTERFACES,
  Db,
  Kernel,
  migrate as kernelMigrate,
  type Session,
} from "@nearesis/kernel";
import { generateSigningKeyPair, signManifest } from "@nearesis/plugin-sdk";
import type { PluginManifest } from "@nearesis/contracts";
import { buildManifest as buildNearThesisManifest } from "@nearesis/near-thesis";
import { createTestDatabase, type TestDatabase } from "../../../workflow/src/db.ts";
import { buildRoleToolsManifest, ROLE_TOOLS_ENTRY } from "./role-tools-manifest.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** nearesis-app root: the plugin root, so plugins from different packages can share one kernel. */
export const APP_ROOT = join(here, "..", "..", "..", "..");
export const TEST_PUBLISHER = "nearesis-deployer-test";

export interface KernelEnv {
  rtdb: TestDatabase;
  /** plain (search_path=public) superuser pool for kernel seeding and ground-truth reads */
  kernelAdmin: pg.Pool;
  kdb: Db;
  kernel: Kernel;
  orgId: string;
  userId: string;
  subject: string;
  session: Session;
  workspaceId: string;
  /** trusted publisher keys, for worker subprocesses that boot their own kernel */
  trustedKeys: Record<string, string[]>;
  newWorkspace(objective?: string): Promise<string>;
  stop(): Promise<void>;
}

/** Signs a manifest with the deployer key after pointing its entrypoint at a path relative to APP_ROOT. */
function signedFor(m: PluginManifest, entryAbs: string, privateKey: string): PluginManifest {
  const out: Record<string, unknown> = { ...m, entrypoint: relative(APP_ROOT, entryAbs) };
  delete out.signature;
  out.signature = signManifest(out as unknown as PluginManifest, privateKey);
  return out as unknown as PluginManifest;
}

export async function makeKernelEnv(opts: { rtdb?: TestDatabase } = {}): Promise<KernelEnv> {
  const rtdb = opts.rtdb ?? (await createTestDatabase());
  await kernelMigrate(rtdb.adminUrl);
  const kernelAdmin = new pg.Pool({ connectionString: rtdb.adminUrl, max: 4 });
  kernelAdmin.on("error", () => undefined);
  const kdb = Db.connect(rtdb.appUrl, 8);
  const keys = generateSigningKeyPair();
  const trustedKeys = { [TEST_PUBLISHER]: [keys.publicKey] };
  const kernel = new Kernel({
    db: kdb,
    plugins: {
      trustMode: "production",
      trustedKeys,
      pluginRoot: APP_ROOT,
      engineInterfaces: DEFAULT_ENGINE_INTERFACES,
      quarantineAfterFailures: 1000,
    },
    sessionSecret: "a6-test-session-secret-0123456789abcdef",
    nodeEnv: "test",
  });
  await kernel.boot();

  const orgId = randomUUID();
  const userId = randomUUID();
  const subject = `a6.owner.${randomBytes(3).toString("hex")}`;
  await kernelAdmin.query("INSERT INTO organizations(id, name) VALUES ($1,$2)", [orgId, "a6-org"]);
  await kernelAdmin.query("INSERT INTO users(id, oidc_subject, display_name) VALUES ($1,$2,$3)", [
    userId,
    subject,
    "owner",
  ]);
  await kernelAdmin.query("INSERT INTO memberships(org_id, user_id, role) VALUES ($1,$2,'owner')", [
    orgId,
    userId,
  ]);
  const token = await kernel.devAuth!.login(subject);
  const session = await kernel.identity.resolveSession(token);

  // production trust: signed manifests, publisher key registered above
  const nt = buildNearThesisManifest({ publisher: TEST_PUBLISHER });
  const entryNt = join(APP_ROOT, "plugins", "near-thesis", "src", "entry.ts");
  await kernel.plugins.install(userId, signedFor(nt, entryNt, keys.privateKey));
  await kernel.plugins.enable(userId, "near-thesis");
  const rt = buildRoleToolsManifest(TEST_PUBLISHER);
  await kernel.plugins.install(userId, signedFor(rt, ROLE_TOOLS_ENTRY, keys.privateKey));
  await kernel.plugins.enable(userId, rt.pluginId);

  const newWorkspace = async (objective = "a6 integration"): Promise<string> => {
    const w = await kernel.workspaces.create(session, {
      objective,
      networkScope: "fixture-only",
      idempotencyKey: `create-${randomUUID()}`,
    });
    let version = w.version;
    for (const pluginId of ["near-thesis", rt.pluginId]) {
      const r = await kernel.commands.execute(session, w.workspaceId, {
        apiVersion: "v1",
        commandId: randomUUID(),
        commandType: "plugin.enable",
        payload: { pluginId },
        expectedVersion: version,
      });
      version = r.workspaceVersion;
    }
    return w.workspaceId;
  };
  const workspaceId = await newWorkspace();
  return {
    rtdb,
    kernelAdmin,
    kdb,
    kernel,
    orgId,
    userId,
    subject,
    session,
    workspaceId,
    trustedKeys,
    newWorkspace,
    async stop() {
      await kernel.close().catch(() => undefined);
      await kernelAdmin.end().catch(() => undefined);
      await rtdb.drop();
    },
  };
}
