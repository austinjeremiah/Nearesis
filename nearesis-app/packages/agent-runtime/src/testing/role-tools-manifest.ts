import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CapabilityDecl, PluginManifest } from "@nearesis/contracts";
import { TOOL_CATALOG } from "../tools.ts";
import { grantString, NEAR_THESIS_CAPABILITIES, LOCAL_COMMAND_TOOLS } from "../grants.ts";

export const ROLE_TOOLS_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
  "role-tools",
  "entry.ts",
);
export const ROLE_TOOLS_PLUGIN_ID = "role-tools-fixture";

/**
 * Capabilities of the fixture plugin: every catalog tool that neither near-thesis nor the runtime itself serves. Its
 * handlers are deterministic stand-ins (research models, evidence store, registry and web fetch have no production
 * implementation yet); the gateway, leases and schema checks in front of them are the real kernel.
 */
export function roleToolsCapabilities(): CapabilityDecl[] {
  const skip = new Set<string>([...NEAR_THESIS_CAPABILITIES, ...LOCAL_COMMAND_TOOLS]);
  return TOOL_CATALOG.filter((t) => !skip.has(t.id)).map((t) => ({
    id: t.id,
    category: "tool.provider",
    sideEffect: t.sideEffect === "read_only" ? "read_only" : "workspace_write",
    idempotent: true,
    providerIdempotencyKey: false,
    latencyClass: "interactive",
    inputSchema: z.toJSONSchema(t.input, { unrepresentable: "any", target: "draft-7" }) as Record<
      string,
      unknown
    >,
    outputSchema: { type: "object" },
    requiredGrants: [grantString(t.id)],
    timeoutMs: 10_000,
    maxOutputBytes: 1_000_000,
  })) as CapabilityDecl[];
}

export function buildRoleToolsManifest(publisher: string): PluginManifest {
  return {
    pluginId: ROLE_TOOLS_PLUGIN_ID,
    version: "1.0.0",
    apiVersion: 1,
    publisher,
    artifactSha256: createHash("sha256").update(readFileSync(ROLE_TOOLS_ENTRY)).digest("hex"),
    capabilities: roleToolsCapabilities(),
    permissions: [],
    networkHosts: [],
    resourceLimits: { memoryMb: 64, cpuMs: 5000, concurrency: 8 },
    configurationSchema: {},
    healthCheck: { intervalMs: 3_600_000 },
    entrypoint: "entry.ts",
    rollbackStrategy: "previous_version",
    requires: [],
  } as PluginManifest;
}
