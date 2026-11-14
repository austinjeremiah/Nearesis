/**
 * Secret scan of exactly what git tracks, with the pinned trivy from scripts/release (final directive s24).
 * `git archive HEAD` is extracted into a temp dir and scanned with `--scanners secret`; any finding fails. Secrets have no
 * waiver path (the release policy BLOCKs every secret). Use after `sh scripts/ci/install-trivy.sh`.
 *
 *   pnpm exec tsx scripts/certify/secret-scan.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseTrivy, scannerInfo, trivyBin, TRIVY_CACHE } from "../release/vuln-scan.ts";

const repo = resolve(import.meta.dirname, "..", "..", "..");
const info = scannerInfo();
if (!info || !info.pinOk) {
  console.error("trivy is missing or is not the pinned version/binary (sh scripts/ci/install-trivy.sh)");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "nearesis-secret-scan-"));
try {
  const tree = join(work, "tree");
  mkdirSync(tree);
  const sh = spawnSync("sh", ["-c", `git -C '${repo}' archive HEAD | tar -x -C '${tree}'`], {
    encoding: "utf8",
  });
  if (sh.status !== 0) throw new Error(`git archive failed: ${sh.stderr}`);
  mkdirSync(TRIVY_CACHE, { recursive: true });
  const r = spawnSync(
    trivyBin(),
    ["fs", "--quiet", "--scanners", "secret", "--skip-db-update", "--format", "json", tree],
    { encoding: "utf8", env: { ...process.env, TRIVY_CACHE_DIR: TRIVY_CACHE }, maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`trivy failed (${r.status}): ${(r.stderr || r.stdout).slice(-400)}`);
  const secrets = parseTrivy(r.stdout).filter((f) => f.kind === "secret");
  console.log(JSON.stringify({ scanner: info, secrets: secrets.length }, null, 2));
  for (const s of secrets)
    console.error(`secret: ${s.id} ${s.severity} ${s.target.replace(tree, "")}:${s.line}`);
  process.exit(secrets.length ? 1 : 0);
} finally {
  rmSync(work, { recursive: true, force: true });
}
