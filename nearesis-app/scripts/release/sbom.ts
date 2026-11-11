/** SBOM record: carries SEC11's `sbomSha256` into the release manifest. Reads SEC11 evidence only when the Build Bible exists. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function readSec11Sbom(
  root: string,
): { sbomSha256: string; evidenceFile: string; imageRefs: string[] } | null {
  const dir = join(root, "..", "NEARESIS_Build_Bible", "reports", "TESTS", "SEC11");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".evidence.json"))
    .sort();
  const f = files[files.length - 1];
  if (!f) return null;
  const e = JSON.parse(readFileSync(join(dir, f), "utf8")) as { sbomSha256?: string; imageRefs?: string[] };
  return e.sbomSha256
    ? { sbomSha256: e.sbomSha256, evidenceFile: `reports/TESTS/SEC11/${f}`, imageRefs: e.imageRefs ?? [] }
    : null;
}
