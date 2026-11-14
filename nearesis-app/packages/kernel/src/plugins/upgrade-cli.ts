/**
 * Operator CLI: make an already-installed version of a plugin the active one (the kernel's audited `upgrade`).
 *
 *   pnpm --filter @nearesis/kernel plugin:upgrade -- --plugin near-thesis --to 1.2.0
 *
 * Install the new version first (`plugin:install -- --root <root> --build-manifest --no-enable`). The previous version stays
 * installed and `rollback` restores it. A running worker/API picks the new active version up on its next call; a plugin file
 * that changed on disk after the active version was installed fails closed (ARTIFACT_HASH_MISMATCH) until this is run.
 */
import { Db } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { PluginManager } from "./manager.ts";

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<number> {
  const plugin = arg("plugin");
  const to = arg("to");
  if (!plugin || !to)
    throw new KernelError(
      "VALIDATION_FAILED",
      "ARGS_REQUIRED",
      "--plugin <id> and --to <version> are required.",
    );
  const db = Db.connect(undefined, 2);
  try {
    // upgrade() reads the stored manifests; trust keys and the plugin root are not used by it
    const pm = new PluginManager(db, {
      trustMode: "production",
      trustedKeys: {},
      pluginRoot: process.cwd(),
      engineInterfaces: ["kernel.tool_gateway@1", "kernel.journal@1", "kernel.leases@1"],
    });
    const r = await pm.upgrade(null, plugin, to);
    console.log(`upgraded ${plugin}: ${r.from} -> ${r.to}`);
    return 0;
  } finally {
    await db.close();
  }
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    if (e instanceof KernelError) console.error(`plugin upgrade rejected: ${e.reasonCode}: ${e.message}`);
    else console.error("plugin upgrade failed.");
    process.exit(1);
  },
);
