/**
 * Release tooling CLI (read-only, offline).
 *   tsx scripts/release/cli.ts manifest [--out DIR]   build manifest, rollback manifest and SBOM record; print validation problems
 *   tsx scripts/release/cli.ts check FILE              validate a manifest file
 *   tsx scripts/release/cli.ts build-images --label L [--ref REF] [--no-cache]   build api, worker, web locally from a clean export (never pushed)
 *   tsx scripts/release/cli.ts promote --label L                                  point the local `live` tags at that build
 *   tsx scripts/release/cli.ts rollback --manifest F --rollback F [--dry-run]     verify then move `live` to the previous release
 * There is no `release` or `broadcast` command: signing and writes are human-only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, validateManifest, validateRollback } from "./manifest.ts";
import type { ReleaseManifest, RollbackManifest } from "./manifest.ts";
import { readSec11Sbom } from "./sbom.ts";
import { buildImages, readBuildRecord, realRun } from "./images.ts";
import type { BuildRecord, ImageName } from "./images.ts";
import { promote, rollback } from "./rollback.ts";

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
} else if (cmd === "build-images") {
  const flag = (n: string) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : undefined);
  const label = flag("label") ?? "candidate";
  const rec = buildImages({
    repoRoot: resolve(root, ".."),
    appDir: "nearesis-app",
    ref: flag("ref") ?? "HEAD",
    label,
    outDir: join(root, ".data", "release", label),
    noCache: rest.includes("--no-cache"),
  });
  console.log(
    JSON.stringify(
      {
        label,
        gitSha: rec.gitSha,
        images: Object.fromEntries(Object.entries(rec.images).map(([k, v]) => [k, v.digest])),
        sbom: rec.sbom,
        vulnerabilityScan: rec.vulnerabilityScan,
      },
      null,
      2,
    ),
  );
} else if (cmd === "promote") {
  const label = rest[rest.indexOf("--label") + 1] ?? "candidate";
  const rec = readBuildRecord(join(root, ".data", "release", label)) as BuildRecord;
  const images = Object.fromEntries(Object.entries(rec.images).map(([k, v]) => [k, v.digest])) as Record<
    ImageName,
    string
  >;
  console.log(JSON.stringify(promote(realRun, images), null, 2));
} else if (cmd === "rollback") {
  const flag = (n: string) => rest[rest.indexOf(`--${n}`) + 1]!;
  const res = rollback({
    current: JSON.parse(readFileSync(flag("manifest"), "utf8")) as ReleaseManifest,
    rollback: JSON.parse(readFileSync(flag("rollback"), "utf8")) as RollbackManifest,
    dryRun: rest.includes("--dry-run"),
  });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.applied || res.dryRun ? (res.plan.ok ? 0 : 1) : 1);
} else {
  console.error("usage: cli.ts manifest [--out DIR] | check FILE | build-images | promote | rollback");
  process.exit(2);
}
