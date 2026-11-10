import { realpathSync, statSync, readFileSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";

const TEXT_EXT = new Set([".md", ".json", ".jsonl", ".txt", ".log", ".yaml", ".yml", ".sql", ".csv"]);
export const MAX_FILE_BYTES = 1_000_000;

export type GuardResult = { ok: true; real: string } | { ok: false; status: number; error: string };

/** Resolve a user-supplied path (relative to the Bible folder) safely. Text files only. */
export function guardPath(bibleDir: string, requested: string): GuardResult {
  if (!requested || requested.includes("\0")) return { ok: false, status: 400, error: "bad path" };
  if (isAbsolute(requested)) return { ok: false, status: 400, error: "absolute paths are not allowed" };
  if (requested.split(/[\\/]/).includes(".."))
    return { ok: false, status: 400, error: "'..' is not allowed" };
  if (!TEXT_EXT.has(extname(requested).toLowerCase())) {
    return { ok: false, status: 415, error: "only text files may be served" };
  }
  let root: string;
  let real: string;
  try {
    root = realpathSync(bibleDir);
  } catch {
    return { ok: false, status: 404, error: "bible folder not found" };
  }
  try {
    real = realpathSync(resolve(root, requested));
  } catch {
    return { ok: false, status: 404, error: "not found" };
  }
  if (real !== root && !real.startsWith(root + sep)) {
    return { ok: false, status: 403, error: "path escapes the Bible folder" };
  }
  let st;
  try {
    st = statSync(real);
  } catch {
    return { ok: false, status: 404, error: "not found" };
  }
  if (!st.isFile()) return { ok: false, status: 400, error: "not a file" };
  if (st.size > MAX_FILE_BYTES) return { ok: false, status: 413, error: "file too large" };
  return { ok: true, real };
}

export function readGuarded(real: string): string {
  return readFileSync(real, "utf8");
}
