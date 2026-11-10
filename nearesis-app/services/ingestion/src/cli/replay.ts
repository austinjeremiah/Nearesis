import { parseArgs } from "node:util";
import { replayDetailed } from "../replay.ts";

const { values } = parseArgs({ options: { snapshot: { type: "string" }, quiet: { type: "boolean" } } });
if (!values.snapshot) {
  console.error("usage: tsx src/cli/replay.ts --snapshot <fixture id>");
  process.exit(2);
}
const r = await replayDetailed(values.snapshot);
let labelled = 0;
let unlabelled = 0;
for (const [t, rows] of Object.entries(r.output.tables)) {
  for (const row of rows as Array<Record<string, unknown>>) {
    if ("sourceLabel" in row) {
      if (row.sourceLabel === "SYNTHETIC" || row.sourceLabel === "RECORDED") labelled++;
      else unlabelled++;
    } else if (!["asset_aliases", "watermarks", "contract_registry"].includes(t)) unlabelled++;
  }
}
const summary = {
  labelledRows: labelled,
  unlabelledRows: unlabelled,
  snapshotId: r.snapshotId,
  digest: r.output.digest,
  expectedDigest: r.expectedDigest,
  digestMatches: r.digestMatches,
  manifestSha256: r.manifestSha256,
  adapterModes: r.adapterModes,
  credentialReads: r.credentialReads,
  rowCounts: Object.fromEntries(
    Object.entries(r.output.tables).map(([k, v]) => [k, (v as unknown[]).length]),
  ),
};
console.log(JSON.stringify(summary));
process.exit(r.digestMatches === false ? 1 : 0);
