import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The sandbox base image (SEC06, SEC12, `sandbox-exec.ts`). `node:24-bookworm-slim` carries the CRITICAL zlib
 * CVE-2023-45853 (will_not_fix), so the sandbox uses `infrastructure/sandbox/Dockerfile`: node 24 trixie-slim pinned by
 * index digest, zlib1g upgraded to the fixed package, npm and corepack removed. It scans PASS under the release
 * vulnerability policy (`scripts/release/vuln-scan.ts`: no CRITICAL, no HIGH with a fix). The runner never pulls
 * (`--pull never`), so a clone builds it once here.
 */
export const SANDBOX_IMAGE = "nearesis-sandbox:trixie-1";
export const SANDBOX_DOCKERFILE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "infrastructure",
  "sandbox",
);

/** Builds the sandbox image when it is absent. Returns whether the image exists afterwards. */
export function ensureSandboxImage(docker = "docker"): boolean {
  const have = () => spawnSync(docker, ["image", "inspect", SANDBOX_IMAGE], { stdio: "ignore" }).status === 0;
  if (have()) return true;
  spawnSync(docker, ["build", "-q", "-t", SANDBOX_IMAGE, SANDBOX_DOCKERFILE_DIR], {
    stdio: "ignore",
    timeout: 600_000,
  });
  return have();
}
