import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;

/** Loads a fixture, verifies every file hash against its manifest and returns the manifest SHA-256 (fixtureHash). */
export function loadFixture<T>(id: string, file: string): { data: T; fixtureHash: string; label: string } {
  const dir = join(here, id);
  const manifestBytes = readFileSync(join(dir, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString()) as {
    label: string;
    files: Array<{ path: string; sha256: string }>;
  };
  for (const f of manifest.files) {
    const got = createHash("sha256")
      .update(readFileSync(join(dir, f.path)))
      .digest("hex");
    if (got !== f.sha256) throw new Error(`fixture ${id}/${f.path} hash mismatch`);
  }
  return {
    data: JSON.parse(readFileSync(join(dir, file), "utf8")) as T,
    fixtureHash: createHash("sha256").update(manifestBytes).digest("hex"),
    label: manifest.label,
  };
}
