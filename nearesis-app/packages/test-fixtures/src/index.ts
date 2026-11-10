import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export interface FixtureManifest {
  id: string;
  label: "SYNTHETIC" | "RECORDED";
  description: string;
  files: Array<{ path: string; sha256: string }>;
  /** snapshots only */
  expectedNormalizedDigest?: string;
  [k: string]: unknown;
}

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

export const fixtureDir = (id: string): string => {
  if (!/^fx\.[a-z0-9.-]+$/.test(id)) throw new Error(`bad fixture id: ${id}`);
  return join(FIXTURES_ROOT, id);
};

export const hasFixture = (id: string): boolean => existsSync(join(fixtureDir(id), "manifest.json"));

export function loadManifest(id: string): FixtureManifest {
  return JSON.parse(readFileSync(join(fixtureDir(id), "manifest.json"), "utf8")) as FixtureManifest;
}

/** SHA-256 of manifest.json (which lists the SHA-256 of every file), per the fixture contract. */
export function fixtureHash(id: string): string {
  return sha(readFileSync(join(fixtureDir(id), "manifest.json")));
}

/** Reads a file of a fixture, verifying it against the manifest hash. */
export function readFixtureFile(id: string, path: string): Uint8Array {
  const m = loadManifest(id);
  const entry = m.files.find((f) => f.path === path);
  if (!entry) throw new Error(`fixture ${id} has no file ${path}`);
  const bytes = new Uint8Array(readFileSync(join(fixtureDir(id), path)));
  if (sha(bytes) !== entry.sha256) throw new Error(`fixture ${id}/${path} hash mismatch`);
  return bytes;
}

export const readFixtureText = (id: string, path: string): string =>
  new TextDecoder().decode(readFixtureFile(id, path));
export const readFixtureJson = <T = unknown>(id: string, path: string): T =>
  JSON.parse(readFixtureText(id, path)) as T;

export function verifyFixture(id: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const m = loadManifest(id);
  for (const f of m.files) {
    try {
      readFixtureFile(id, f.path);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { ok: errors.length === 0, errors };
}
