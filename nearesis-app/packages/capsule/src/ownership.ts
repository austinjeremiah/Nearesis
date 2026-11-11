import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Tenant ownership of a stored capsule. It lives beside the capsule (`ownership.json`), outside the hashed manifest and
 * file list, so assigning or reading it never changes a capsule hash. A capsule without a valid record is unowned and
 * must be treated as nonexistent by every API read.
 */
export const CapsuleOwnership = z.strictObject({
  orgId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type CapsuleOwnership = z.infer<typeof CapsuleOwnership>;

export const OWNERSHIP_FILE = "ownership.json";

export function writeCapsuleOwnership(capsuleDir: string, owner: CapsuleOwnership): void {
  writeFileSync(join(capsuleDir, OWNERSHIP_FILE), JSON.stringify(CapsuleOwnership.parse(owner)) + "\n");
}

export function readCapsuleOwnership(capsuleDir: string): CapsuleOwnership | null {
  const p = join(capsuleDir, OWNERSHIP_FILE);
  if (!existsSync(p)) return null;
  try {
    const r = CapsuleOwnership.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
