import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const CAPSULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

const manifestIdOf = (dir: string): string | null => {
  try {
    const f = join(dir, "manifest.json");
    if (!existsSync(f)) return null;
    const id = (JSON.parse(readFileSync(f, "utf8")) as { capsuleId?: unknown }).capsuleId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
};

/**
 * Capsule directory for an id. The identity of a capsule is the `capsuleId` in its manifest: a directory named exactly
 * like the id is tried first, then every directory is matched on its manifest id. A directory whose NAME is the id but
 * whose manifest names another capsule is only a fallback (when no manifest carries that id), so the same id always
 * resolves to the same capsule on every route.
 */
export function resolveCapsuleDir(root: string, id: string): string | null {
  if (!CAPSULE_ID.test(id)) return null;
  const direct = join(root, id);
  if (manifestIdOf(direct) === id) return direct;
  if (existsSync(root))
    for (const n of readdirSync(root).sort()) {
      if (n === id) continue;
      const d = join(root, n);
      if (manifestIdOf(d) === id) return d;
    }
  return existsSync(join(direct, "manifest.json")) ? direct : null;
}
