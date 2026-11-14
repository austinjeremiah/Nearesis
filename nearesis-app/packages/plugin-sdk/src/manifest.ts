import { PluginManifest } from "@nearesis/contracts";
import type { CapabilityGrant } from "@nearesis/contracts";

export class ManifestError extends Error {
  readonly issues: Array<{ path: string; issue: string }>;
  constructor(issues: Array<{ path: string; issue: string }>) {
    super(`invalid plugin manifest: ${issues.map((i) => `${i.path}: ${i.issue}`).join("; ")}`);
    this.name = "ManifestError";
    this.issues = issues;
  }
}

export function parseManifest(raw: unknown): PluginManifest {
  const r = PluginManifest.safeParse(raw);
  if (r.success) {
    const ids = r.data.capabilities.map((c) => c.id);
    if (new Set(ids).size !== ids.length) {
      throw new ManifestError([{ path: "capabilities", issue: "duplicate capability id" }]);
    }
    return r.data;
  }
  throw new ManifestError(r.error.issues.map((i) => ({ path: i.path.join("."), issue: i.message })));
}

export function majorOf(version: string): number {
  return Number(version.split(".")[0]);
}

export function grantKey(g: Pick<CapabilityGrant, "resource" | "action">): string {
  return `${g.resource}:${g.action}`;
}
