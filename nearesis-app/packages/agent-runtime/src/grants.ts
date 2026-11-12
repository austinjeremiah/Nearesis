import type { CapabilityGrant } from "@nearesis/contracts";

/**
 * Kernel grant required by each agent-visible capability. The semantic and canvas capabilities carry the grants the
 * near-thesis plugin manifest declares (`semantic:query`, `semantic:discover`, `canvas:preview`). Every other
 * capability uses `tool:<capability id>` so a lease on one tool never authorises another.
 * `canvas.patch@1` is not a plugin capability: it maps to the kernel `canvas.apply_patch` command and is gated here.
 */
export function grantFor(capability: string): { resource: string; action: string } {
  switch (capability) {
    case "semantic.query@1":
      return { resource: "semantic", action: "query" };
    case "semantic.discover@1":
      return { resource: "semantic", action: "discover" };
    case "metric.propose@1":
      return { resource: "metric", action: "propose" };
    case "canvas.preview@1":
      return { resource: "canvas", action: "preview" };
    case "canvas.patch@1":
      return { resource: "canvas", action: "patch" };
    default:
      return { resource: "tool", action: capability };
  }
}
export const grantString = (capability: string): string => {
  const g = grantFor(capability);
  return `${g.resource}:${g.action}`;
};
export type { CapabilityGrant };

/** Capabilities served by the near-thesis plugin; all others in the catalog come from a role-tools plugin or the runtime. */
export const NEAR_THESIS_CAPABILITIES = [
  "semantic.query@1",
  "semantic.discover@1",
  "canvas.preview@1",
  "metric.propose@1",
] as const;
/** Tools executed by the runtime itself against a kernel command (not through the plugin gateway). */
export const LOCAL_COMMAND_TOOLS = ["canvas.patch@1"] as const;
