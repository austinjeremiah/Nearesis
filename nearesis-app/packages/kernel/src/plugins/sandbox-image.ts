import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The sandbox image (SEC06, SEC12, `sandbox-exec.ts`): `infrastructure/sandbox/Dockerfile`, Google distroless nodejs24 on
 * Debian 13 pinned by index digest (node only: no shell, package manager, npm, util-linux, perl or ncurses). It is a
 * mandatory member of the release image set and scan (`scripts/release/vuln-scan.ts` MANDATORY_IMAGES): 0 CRITICAL and
 * 0 HIGH. The runner never pulls (`--pull never`), so a clone builds it once here.
 */
export const SANDBOX_IMAGE = "nearesis-sandbox:distroless-1";
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
