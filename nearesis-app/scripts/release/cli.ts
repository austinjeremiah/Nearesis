/**
 * Release tooling CLI (read-only, offline).
 *   tsx scripts/release/cli.ts manifest [--out DIR]   build manifest, rollback manifest and SBOM record; print validation problems
 *   tsx scripts/release/cli.ts check FILE              validate a manifest file
 * There is no `release` or `broadcast` command: signing and writes are human-only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, validateManifest, validateRollback } from "./manifest.ts";
import type { ReleaseManifest } from "./manifest.ts";
import { readSec11Sbom } from "./sbom.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "manifest") {
  const out = rest[rest.indexOf("--out") + 1] ?? join(root, ".data", "release");
  const sbom = readSec11Sbom(root);
  const { manifest, rollback } = buildManifest({
    root,
    sbomSha256: sbom?.sbomSha256 ?? null,
    expectedMaxSpend: "0.05 NEAR",
    balanceCeiling: "10",
    feeCeiling: "1",
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "release-manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(out, "rollback-manifest.json"), JSON.stringify(rollback, null, 2));
  writeFileSync(
    join(out, "sbom-record.json"),
    JSON.stringify(sbom ?? { sbomSha256: null, note: "SEC11 evidence not found" }, null, 2),
  );
  console.log(
    JSON.stringify(
      { out, problems: [...validateManifest({ ...manifest }), ...validateRollback(rollback, manifest)] },
      null,
      2,
    ),
  );
} else if (cmd === "check") {
  const m = JSON.parse(readFileSync(rest[0]!, "utf8")) as ReleaseManifest;
  const p = validateManifest({ ...m });
  console.log(JSON.stringify(p, null, 2));
  process.exit(p.length ? 1 : 0);
} else {
  console.error("usage: cli.ts manifest [--out DIR] | check FILE");
  process.exit(2);
}
