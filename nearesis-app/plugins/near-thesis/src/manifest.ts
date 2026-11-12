import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginManifest } from "@nearesis/contracts";
import { signManifest } from "@nearesis/plugin-sdk";
import { CAPABILITIES } from "./capabilities.ts";

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ENTRY_FILE = join(PLUGIN_ROOT, "src", "entry.ts");

/**
 * near-thesis plugin manifest. `artifactSha256` is the hash of the entry module bytes. Signing uses an ed25519 key
 * held by the deployer (never in the repo); unsigned manifests are only installable under the kernel's dev_trust mode.
 */
export function buildManifest(
  opts: { publisher: string; privateKey?: string; version?: string } = { publisher: "nearesis" },
): PluginManifest {
  const m: Record<string, unknown> = {
    pluginId: "near-thesis",
    version: opts.version ?? "1.1.0",
    apiVersion: 1,
    publisher: opts.publisher,
    artifactSha256: createHash("sha256").update(readFileSync(ENTRY_FILE)).digest("hex"),
    capabilities: CAPABILITIES,
    permissions: ["semantic:read", "canvas:preview", "metric:propose"],
    networkHosts: [
      "127.0.0.1:4000",
      "127.0.0.1:4001",
      "127.0.0.1:58123",
      "127.0.0.1:56379",
      "127.0.0.1:55432",
    ],
    resourceLimits: { memoryMb: 256, cpuMs: 30_000, concurrency: 8 },
    configurationSchema: {},
    healthCheck: { capability: "semantic.discover@1", intervalMs: 60_000 },
    entrypoint: relative(PLUGIN_ROOT, ENTRY_FILE),
    rollbackStrategy: "previous_version",
    requires: [],
  };
  if (opts.privateKey) m.signature = signManifest(m as unknown as PluginManifest, opts.privateKey);
  return m as unknown as PluginManifest;
}
