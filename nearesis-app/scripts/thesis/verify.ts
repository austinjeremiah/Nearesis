/** `pnpm thesis:verify`: rebuilds into a temp directory and compares every hash with thesis/build/HASHES.json. Exit 0 only if identical. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Hex } from "../../packages/plugin-sdk/src/canonical.ts";
import { buildBundle, writeBundle } from "./build.ts";
import { DEFAULT_RESULTS_DIR, DEFAULT_THESIS_DIR } from "./inputs.ts";

export interface VerifyResult {
  ok: boolean;
  checked: number;
  problems: string[];
}

export function verifyBundle(
  o: { thesisDir?: string; resultsDir?: string; buildDir?: string } = {},
): VerifyResult {
  const thesisDir = o.thesisDir ?? DEFAULT_THESIS_DIR;
  const buildDir = o.buildDir ?? join(thesisDir, "build");
  const problems: string[] = [];
  const hashesPath = join(buildDir, "HASHES.json");
  if (!existsSync(hashesPath))
    return { ok: false, checked: 0, problems: [`${hashesPath} not found; run pnpm thesis:build`] };
  const recorded = JSON.parse(readFileSync(hashesPath, "utf8")) as {
    files: { path: string; sha256: string }[];
    inputs: { path: string; sha256: string }[];
  };
  const tmp = mkdtempSync(join(tmpdir(), "thesis-verify-"));
  let checked = 0;
  try {
    let rebuilt;
    try {
      rebuilt = buildBundle({ thesisDir, resultsDir: o.resultsDir ?? DEFAULT_RESULTS_DIR });
    } catch (e) {
      return { ok: false, checked, problems: [`rebuild failed: ${(e as Error).message}`] };
    }
    writeBundle(rebuilt, tmp);
    const fresh = new Map([...rebuilt.files].map(([rel, body]) => [rel, sha256Hex(body)]));
    for (const f of recorded.files) {
      checked++;
      const rel = f.path.replace(/^build\//, "");
      const onDisk = join(buildDir, rel);
      if (!existsSync(onDisk)) {
        problems.push(`${f.path}: missing on disk`);
        continue;
      }
      const disk = sha256Hex(readFileSync(onDisk));
      if (disk !== f.sha256) problems.push(`${f.path}: file on disk differs from HASHES.json`);
      if (fresh.get(rel) !== f.sha256) problems.push(`${f.path}: rebuild differs from HASHES.json`);
    }
    const freshHashes = JSON.parse(rebuilt.files.get("HASHES.json")!) as {
      inputs: { path: string; sha256: string }[];
    };
    const have = new Map(recorded.inputs.map((i) => [i.path, i.sha256]));
    for (const i of freshHashes.inputs) {
      checked++;
      if (have.get(i.path) !== i.sha256) problems.push(`input ${i.path}: changed since the recorded build`);
    }
    for (const p of have.keys())
      if (!freshHashes.inputs.some((i) => i.path === p)) problems.push(`input ${p}: no longer read`);
    if (sha256Hex(readFileSync(hashesPath)) !== fresh.get("HASHES.json"))
      problems.push("HASHES.json: rebuild differs");
    checked++;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { ok: problems.length === 0, checked, problems };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = verifyBundle({
    ...(arg("thesis") ? { thesisDir: arg("thesis")! } : {}),
    ...(arg("results") ? { resultsDir: arg("results")! } : {}),
    ...(arg("out") ? { buildDir: arg("out")! } : {}),
  });
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
