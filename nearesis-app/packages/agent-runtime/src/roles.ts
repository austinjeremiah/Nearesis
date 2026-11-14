import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AgentRole, CapabilityId } from "@nearesis/contracts";

export const RoleConfig = z.strictObject({
  role: AgentRole,
  version: z.string().min(1),
  input: z.string().min(1),
  allowedTools: z.array(CapabilityId).min(1),
  artifact: z.string().min(1),
  stopConditions: z.array(z.string().min(1)).min(1),
  systemPrompt: z.string().min(1),
});
export type RoleConfig = z.infer<typeof RoleConfig>;

const ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "roles");

/** Loads and validates every role config; throws unless exactly the 10 ch.05 roles are present. */
export function loadRoles(dir: string = ROLES_DIR): Map<AgentRole, RoleConfig> {
  const out = new Map<AgentRole, RoleConfig>();
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".json"))
    .sort()) {
    const cfg = RoleConfig.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    if (out.has(cfg.role)) throw new Error(`duplicate role ${cfg.role}`);
    out.set(cfg.role, cfg);
  }
  for (const r of AgentRole.options) if (!out.has(r)) throw new Error(`missing role config ${r}`);
  if (out.size !== AgentRole.options.length) throw new Error("unexpected role count");
  return out;
}
