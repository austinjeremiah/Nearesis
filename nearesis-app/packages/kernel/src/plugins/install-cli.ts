/**
 * Operator CLI: install a signed plugin from a plugin root with production trust.
 *
 *   pnpm --filter @nearesis/kernel plugin:install -- --root plugins/near-thesis [--manifest <file>] [--build-manifest] [--no-enable]
 *
 * - Trusted publisher keys come from NEARESIS_PLUGIN_TRUSTED_KEYS (JSON, public keys only; repo-root .env is read).
 * - Default manifest: <root>/plugin.manifest.json (signed by the plugin's build step).
 * - --build-manifest: sign in memory with NEARESIS_PLUGIN_SIGNING_KEY (deployer private key, never printed) and
 *   NEARESIS_PLUGIN_PUBLISHER (default "nearesis") using the plugin's own buildManifest.
 * - Relative paths resolve from the directory pnpm was invoked in.
 * - Exit code 0 on installed/already_installed, 1 on rejection (the reason code is printed, never key material).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { buildSignedManifest, installPluginFromRoot, loadTrustedKeys, readManifestFile } from "./install.ts";

function loadDotEnv(): void {
  const p = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

function parseArgs(argv: string[]): { root?: string; manifest?: string; build: boolean; enable: boolean } {
  const out: { root?: string; manifest?: string; build: boolean; enable: boolean } = {
    build: false,
    enable: true,
  };
  const args = argv.filter((a) => a !== "--");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--root") out.root = args[++i];
    else if (a === "--manifest") out.manifest = args[++i];
    else if (a === "--build-manifest") out.build = true;
    else if (a === "--no-enable") out.enable = false;
    else throw new KernelError("VALIDATION_FAILED", "BAD_ARGUMENT", `Unknown argument ${a}.`);
  }
  return out;
}

async function main(): Promise<number> {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (!args.root)
    throw new KernelError("VALIDATION_FAILED", "ROOT_REQUIRED", "--root <plugin root> is required.");
  const base = process.env.INIT_CWD ?? process.cwd();
  const root = resolve(base, args.root);
  const trustedKeys = loadTrustedKeys();
  if (Object.keys(trustedKeys).length === 0)
    throw new KernelError(
      "VALIDATION_FAILED",
      "NO_TRUSTED_KEYS",
      "NEARESIS_PLUGIN_TRUSTED_KEYS is not configured; production trust needs at least one trusted publisher key.",
    );
  let manifest: unknown;
  if (args.build) {
    const privateKey = process.env.NEARESIS_PLUGIN_SIGNING_KEY;
    if (!privateKey)
      throw new KernelError(
        "VALIDATION_FAILED",
        "SIGNING_KEY_MISSING",
        "--build-manifest needs NEARESIS_PLUGIN_SIGNING_KEY.",
      );
    manifest = await buildSignedManifest(root, {
      publisher: process.env.NEARESIS_PLUGIN_PUBLISHER ?? "nearesis",
      privateKey,
    });
  } else {
    manifest = readManifestFile(root, args.manifest ? resolve(base, args.manifest) : undefined);
  }
  const db = Db.connect(undefined, 2);
  try {
    const r = await installPluginFromRoot(db, {
      root,
      trustedKeys,
      manifest,
      enable: args.enable,
      nodeEnv: process.env.NODE_ENV,
    });
    console.log(
      `${r.outcome}: ${r.pluginId}@${r.version} state=${r.state} active=${r.active}. Run the API with NEARESIS_PLUGIN_ROOT=${root}`,
    );
    return 0;
  } finally {
    await db.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof KernelError) console.error(`plugin install rejected: ${e.reasonCode}: ${e.message}`);
    else console.error("plugin install failed.");
    process.exit(1);
  },
);
