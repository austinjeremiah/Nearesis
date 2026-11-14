import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256Hex } from "./canonical.ts";

/** Relative path to SHA-256 for every file under `dir`, sorted. */
export function treeHashOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split("\\").join("/")] = sha256Hex(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}
