import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginManifest } from "@nearesis/contracts";
import { KernelError } from "../errors.ts";
import type { Db } from "../db/pool.ts";
import { PluginManager } from "./manager.ts";
import type { InstallationRow, PluginManagerConfig } from "./manager.ts";

/** Interfaces the kernel engine provides to plugins (same list the API boots with). */
const ENGINE_INTERFACES = ["kernel.tool_gateway@1", "kernel.journal@1", "kernel.leases@1"];

/** Environment variable holding trusted publisher keys: JSON `{ "<publisher>": ["<base64 SPKI ed25519>", ...] }`. */
export const TRUSTED_KEYS_ENV = "NEARESIS_PLUGIN_TRUSTED_KEYS";
/** Conventional location of a pre-signed manifest inside a plugin root. */
export const MANIFEST_FILE = "plugin.manifest.json";

/**
 * Trusted publisher keys from configuration. Public keys only; the deployer's private signing key never lives in the
 * kernel configuration. Malformed configuration fails closed (an error, never an empty-but-silently-valid trust set).
 */
export function loadTrustedKeys(
  env: Record<string, string | undefined> = process.env,
): Record<string, string[]> {
  const raw = env[TRUSTED_KEYS_ENV];
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KernelError(
      "VALIDATION_FAILED",
      "TRUSTED_KEYS_INVALID",
      `${TRUSTED_KEYS_ENV} is not valid JSON.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new KernelError(
      "VALIDATION_FAILED",
      "TRUSTED_KEYS_INVALID",
      `${TRUSTED_KEYS_ENV} must be an object.`,
    );
  const out: Record<string, string[]> = {};
  for (const [publisher, keys] of Object.entries(parsed)) {
    if (
      !Array.isArray(keys) ||
      keys.length === 0 ||
      !keys.every((k) => typeof k === "string" && k.length > 0)
    )
      throw new KernelError(
        "VALIDATION_FAILED",
        "TRUSTED_KEYS_INVALID",
        `${TRUSTED_KEYS_ENV}: publisher "${publisher}" needs a non-empty array of base64 keys.`,
      );
    out[publisher] = keys as string[];
  }
  return out;
}

export interface InstallPluginOptions {
  /** Plugin root directory (entrypoint is resolved inside it and may not escape it). */
  root: string;
  /** Publisher -> trusted public keys. Production trust requires a valid signature from one of these. */
  trustedKeys: Record<string, string[]>;
  /** Signed manifest to install. Default: `<root>/plugin.manifest.json`. */
  manifest?: unknown;
  /** Enable (activate) the installed version globally. Default true. Workspaces still opt in via `plugin.enable`. */
  enable?: boolean;
  actorId?: string | null;
  /** Defaults to process.env.NODE_ENV. */
  nodeEnv?: string | undefined;
  engineInterfaces?: string[];
}

export interface InstallPluginResult {
  pluginId: string;
  version: string;
  installationId: string;
  state: InstallationRow["state"];
  active: boolean;
  /** `already_installed` when this exact version was installed before (idempotent re-run). */
  outcome: "installed" | "already_installed";
}

/** Read a manifest file from a plugin root (or an explicit path). */
export function readManifestFile(root: string, path?: string): unknown {
  const file = path ? resolve(root, path) : join(resolve(root), MANIFEST_FILE);
  if (!existsSync(file))
    throw new KernelError(
      "NOT_FOUND",
      "MANIFEST_FILE_MISSING",
      `No signed manifest at ${file}. Build and sign one with the plugin's buildManifest, or pass --build-manifest with a signing key.`,
    );
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new KernelError("VALIDATION_FAILED", "MANIFEST_INVALID", `Manifest ${file} is not valid JSON.`);
  }
}

/**
 * Deployer convenience: import `<root>/src/manifest.ts`'s `buildManifest` and sign in memory with the deployer's private
 * key. Nothing is written into the plugin directory. The resulting signature is still verified against `trustedKeys`
 * by the kernel at install, so signing with an untrusted key is rejected.
 */
export async function buildSignedManifest(
  root: string,
  opts: { publisher: string; privateKey: string; version?: string },
): Promise<unknown> {
  const file = join(resolve(root), "src", "manifest.ts");
  if (!existsSync(file))
    throw new KernelError(
      "NOT_FOUND",
      "MANIFEST_BUILDER_MISSING",
      `No src/manifest.ts under ${resolve(root)}.`,
    );
  const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { buildManifest?: unknown };
  if (typeof mod.buildManifest !== "function")
    throw new KernelError(
      "VALIDATION_FAILED",
      "MANIFEST_BUILDER_MISSING",
      "src/manifest.ts has no buildManifest export.",
    );
  return (mod.buildManifest as (o: unknown) => unknown)(opts);
}

/**
 * Install a signed plugin from a plugin root with PRODUCTION trust. There is no dev_trust path here: an unsigned or
 * untrusted manifest is rejected by the kernel before its entrypoint is read. Idempotent per (pluginId, version).
 * Operators must run the API with `NEARESIS_PLUGIN_ROOT` set to the same root so the installed module can be re-loaded.
 */
export async function installPluginFromRoot(db: Db, o: InstallPluginOptions): Promise<InstallPluginResult> {
  const root = isAbsolute(o.root) ? o.root : resolve(o.root);
  if (!existsSync(root))
    throw new KernelError("NOT_FOUND", "PLUGIN_ROOT_MISSING", `Plugin root ${root} does not exist.`);
  const config: PluginManagerConfig = {
    trustMode: "production",
    trustedKeys: o.trustedKeys,
    pluginRoot: root,
    engineInterfaces: o.engineInterfaces ?? ENGINE_INTERFACES,
    ...(o.nodeEnv !== undefined ? { nodeEnv: o.nodeEnv } : {}),
  };
  const plugins = new PluginManager(db, config);
  const raw = o.manifest ?? readManifestFile(root);
  const m = raw as Partial<PluginManifest> | null;
  const existing =
    typeof m?.pluginId === "string" && typeof m.version === "string"
      ? await plugins.findInstallation(m.pluginId, m.version)
      : undefined;
  const actorId = o.actorId ?? null;
  let inst = existing;
  let outcome: InstallPluginResult["outcome"] = "already_installed";
  if (!inst) {
    inst = await plugins.install(actorId, raw);
    outcome = "installed";
  }
  if ((o.enable ?? true) && !inst.active) inst = await plugins.enable(actorId, inst.pluginId, inst.version);
  return {
    pluginId: inst.pluginId,
    version: inst.version,
    installationId: inst.id,
    state: inst.state,
    active: inst.active,
    outcome,
  };
}
