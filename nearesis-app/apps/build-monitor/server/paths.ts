import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface MonitorPaths {
  /** Root that /api/file may read from (the Bible folder). */
  bibleDir: string;
  coordDir: string;
  reportsDir: string;
  testIndex: string;
  /** Git working tree used for `git log`. */
  repoRoot: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(here, "..", "..", "..");
export const REPO_ROOT = resolve(APP_ROOT, "..");

export function defaultPaths(env: NodeJS.ProcessEnv = process.env): MonitorPaths {
  const bibleDir = env.NEARESIS_BIBLE_DIR ?? join(REPO_ROOT, "NEARESIS_Build_Bible");
  return {
    bibleDir,
    coordDir: env.NEARESIS_COORD_DIR ?? join(bibleDir, "coordination"),
    reportsDir: env.NEARESIS_REPORTS_DIR ?? join(bibleDir, "reports"),
    testIndex: env.NEARESIS_TEST_INDEX ?? join(APP_ROOT, "tests", "TEST_INDEX.json"),
    repoRoot: REPO_ROOT,
  };
}
