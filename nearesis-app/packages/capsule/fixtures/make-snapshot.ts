/** Regenerates fixtures/snapshot-synthetic (deterministic). Usage: tsx fixtures/make-snapshot.ts <analysisCodeCommit> */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../src/canonical.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "snapshot-synthetic");
mkdirSync(join(out, "raw"), { recursive: true });

// Deterministic LCG; the signer series follows the volume series by 7 days plus noise. SYNTHETIC: not NEAR data.
let s = 20261111n;
const rnd = (): bigint => {
  s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
  return (s >> 33n) % 1000n;
};
const days = 90;
const start = Date.UTC(2026, 7, 13);
const vol: bigint[] = [];
for (let i = 0; i < days; i++) vol.push(10_000_000n + BigInt(i) * 35_000n + rnd() * 4_000n);
const rows = ["date,intents_volume_usd_cents,active_signers"];
for (let i = 0; i < days; i++) {
  const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
  const lead = i >= 7 ? vol[i - 7]! : vol[0]!;
  rows.push(`${d},${vol[i]},${40_000n + lead / 1000n + rnd() / 4n}`);
}
const csv = Buffer.from(`${rows.join("\n")}\n`);
writeFileSync(join(out, "raw", "daily_series.csv"), csv);
const descriptor = {
  schema: "nearesis.snapshot.v1",
  snapshotId: "synthetic-2026-11-10",
  label: "SYNTHETIC",
  frozenAt: "2026-11-11T00:00:00Z",
  dataset: "SYNTHETIC fixture - not NEAR production data",
  claimId: "syn:intents-leads-signers",
  analysisCodeCommit: process.argv[2] ?? "0000000",
  series: {
    file: "raw/daily_series.csv",
    x: { column: "intents_volume_usd_cents", name: "intents_volume_proxy", unit: "usd_cents" },
    y: { column: "active_signers", name: "active_signers_proxy", unit: "accounts" },
  },
  metrics: ["lag_pearson:7", "pearson", "summary"],
  files: [{ path: "raw/daily_series.csv", sha256: sha256Hex(csv), bytes: csv.length }],
};
writeFileSync(join(out, "snapshot.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
console.log("wrote", out, sha256Hex(csv));
