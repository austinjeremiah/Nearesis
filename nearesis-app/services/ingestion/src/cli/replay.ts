import { parseArgs } from "node:util";
import { replayDetailed } from "../replay.ts";

const { values } = parseArgs({ options: { snapshot: { type: "string" }, quiet: { type: "boolean" } } });
if (!values.snapshot) {
  console.error("usage: tsx src/cli/replay.ts --snapshot <fixture id>");
  process.exit(2);
}
const r = await replayDetailed(values.snapshot);
const summary = {
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
