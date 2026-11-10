import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { z } from "zod";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(APP_ROOT, "..");
export const BIBLE = join(REPO_ROOT, "NEARESIS_Build_Bible");
export const COORD = process.env.NEARESIS_COORD_DIR ?? join(BIBLE, "coordination");
export const REPORTS = process.env.NEARESIS_REPORTS_DIR ?? join(BIBLE, "reports");

/** Atomic write: temp file in same dir + rename (POSIX atomic). */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Exclusive lease via O_EXCL lock file; stale after 30 s. Serializes read-modify-write of shared JSON. */
export function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true });
      } catch {
        /* lock vanished */
      }
      if (Date.now() > deadline) throw new Error(`lock timeout: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

export function readJson<T>(path: string, schema?: z.ZodType<T>): T {
  const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return schema ? schema.parse(v) : (v as T);
}

/** EVENTS.jsonl is append-only; each line < 4 KiB so O_APPEND writes are atomic. */
export function appendEvent(line: object): void {
  const s = JSON.stringify(line);
  if (Buffer.byteLength(s) > 4000) throw new Error("event line too large");
  appendFileSync(join(COORD, "EVENTS.jsonl"), s + "\n");
}

export function gitHead(): string | null {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

export const exists = existsSync;
