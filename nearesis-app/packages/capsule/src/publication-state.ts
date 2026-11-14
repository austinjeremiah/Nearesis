import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CapsuleManifest } from "@nearesis/contracts";
import { readCapsuleOwnership } from "./ownership.ts";

/**
 * Explicit public publication of a stored capsule (ch.12, ADR-20261112-001 "Public MCP"). The record lives beside the
 * capsule (`publication-state.json`), outside the hashed manifest, like `ownership.json`. A capsule is public only
 * while its latest record says `published` AND names the same org and workspace as its ownership record. A capsule
 * without a valid record, a draft, an unpublished one, a failed or non-validated one is never public by default.
 */
export const PUBLICATION_STATE_FILE = "publication-state.json";

export const CapsulePublicationState = z.strictObject({
  state: z.enum(["published", "unpublished"]),
  orgId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  actorId: z.string().min(1).max(120),
  at: z.string().min(1).max(40),
  /** Cautionary research statuses the publisher explicitly acknowledged (empty for a clean capsule). */
  acknowledged: z.array(z.string().max(60)).max(10),
  /** Verification badge (ch.12 verified state) the publication displays. */
  badge: z.enum(["verified", "unverified", "failed"]),
});
export type CapsulePublicationState = z.infer<typeof CapsulePublicationState>;

export function writeCapsulePublicationState(capsuleDir: string, s: CapsulePublicationState): void {
  const target = join(capsuleDir, PUBLICATION_STATE_FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(CapsulePublicationState.parse(s)) + "\n");
  renameSync(tmp, target);
}

export function readCapsulePublicationState(capsuleDir: string): CapsulePublicationState | null {
  const p = join(capsuleDir, PUBLICATION_STATE_FILE);
  if (!existsSync(p)) return null;
  try {
    const r = CapsulePublicationState.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** True only for an explicitly published capsule whose publication record matches its ownership record. */
export function isCapsulePublic(capsuleDir: string): boolean {
  const pub = readCapsulePublicationState(capsuleDir);
  if (!pub || pub.state !== "published") return false;
  const owner = readCapsuleOwnership(capsuleDir);
  return !!owner && owner.orgId === pub.orgId && owner.workspaceId === pub.workspaceId;
}

const CAUTION = new Set(["INSUFFICIENT_DATA", "METHOD_NOT_VALIDATED", "NOT_REPRODUCIBLE"]);

/**
 * Cautionary statuses carried by a capsule: the research verdict and any inference status among the results, plus a
 * non-verified attestation block. Publishing such a capsule needs each one named in `acknowledged`.
 */
export function cautionStatuses(m: CapsuleManifest): string[] {
  const out = new Set<string>();
  for (const r of m.results) {
    const v = String(r.value).toUpperCase();
    for (const tok of v.split(/[^A-Z_]+/)) if (CAUTION.has(tok)) out.add(tok);
  }
  if (m.attestation?.status === "blocked") out.add("ATTESTATION_BLOCKED");
  return [...out].sort();
}
