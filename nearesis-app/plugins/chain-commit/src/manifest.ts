import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityDecl, PluginManifest } from "@nearesis/contracts";
import { signManifest } from "@nearesis/plugin-sdk";
import { CAPABILITY } from "./entry.ts";
import { COMMIT_INPUT_SCHEMA } from "./policy.ts";

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ENTRY_FILE = join(PLUGIN_ROOT, "src", "entry.ts");

export const COMMIT_CAPABILITY = {
  id: CAPABILITY,
  category: "network.adapter",
  sideEffect: "chain_write",
  idempotent: false,
  providerIdempotencyKey: false,
  latencyClass: "interactive",
  inputSchema: COMMIT_INPUT_SCHEMA,
  outputSchema: { type: "object" },
  requiredGrants: ["chain:commit"],
  timeoutMs: 60_000,
  maxOutputBytes: 10_000,
} as unknown as CapabilityDecl;

/** `networkHosts` must be the exact `127.0.0.1:port` (or testnet RPC host) endpoints; nothing else is reachable. */
export function buildManifest(opts: {
  publisher: string;
  networkHosts: string[];
  privateKey?: string;
  version?: string;
}): PluginManifest {
  const m: Record<string, unknown> = {
    pluginId: "chain-commit",
    version: opts.version ?? "1.0.0",
    apiVersion: 1,
    publisher: opts.publisher,
    artifactSha256: createHash("sha256").update(readFileSync(ENTRY_FILE)).digest("hex"),
    capabilities: [COMMIT_CAPABILITY],
    permissions: [],
    networkHosts: opts.networkHosts,
    resourceLimits: { memoryMb: 64, cpuMs: 5000, concurrency: 2 },
    configurationSchema: {},
    healthCheck: { intervalMs: 60_000 },
    entrypoint: relative(PLUGIN_ROOT, ENTRY_FILE),
    rollbackStrategy: "previous_version",
    requires: [],
  };
  if (opts.privateKey) m.signature = signManifest(m as unknown as PluginManifest, opts.privateKey);
  return m as unknown as PluginManifest;
}
