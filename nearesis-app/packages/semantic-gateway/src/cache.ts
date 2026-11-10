import { createHash } from "node:crypto";

export interface CacheKeyParts {
  tenantId: string;
  workspaceId: string;
  aclClasses: string[];
  semanticVersion: string;
  semanticModelHash: string;
  sourceVintage: string;
  queryHash: string;
}

const enc = (s: string) => encodeURIComponent(s).replace(/:/g, "%3A");
export const aclClassOf = (acl: string[]) =>
  createHash("sha256")
    .update([...new Set(acl)].sort().join("\n"))
    .digest("hex")
    .slice(0, 12);

/**
 * `semantic:q:<tenant>:<workspace>:<acl>:<semver>:<semhash12>:<vintage>:<queryhash>`.
 * Scope, ACL class, semantic version/hash and source vintage are separate components, so a change in any of them
 * produces a different key and no result can cross scopes or survive a semantic change.
 */
export function buildCacheKey(p: CacheKeyParts): string {
  return [
    "semantic",
    "q",
    enc(p.tenantId),
    enc(p.workspaceId),
    aclClassOf(p.aclClasses),
    p.semanticVersion,
    p.semanticModelHash.slice(0, 12),
    p.sourceVintage,
    p.queryHash.slice(0, 32),
  ].join(":");
}

export function parseCacheKey(key: string) {
  const [prefix, kind, tenant, workspace, acl, semanticVersion, semanticHash, vintage, queryHash] =
    key.split(":");
  return { prefix, kind, tenant, workspace, acl, semanticVersion, semanticHash, vintage, queryHash };
}
