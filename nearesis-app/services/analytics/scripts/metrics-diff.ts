/**
 * Dataset-backed registry diff. Usage:
 *   pnpm --filter @nearesis/analytics metrics:diff -- --change change.json --from 2026-10-01 --to 2026-10-10 [--dependents deps.json]
 * `change.json` is a ChangeProposal ({metricId, patch, evaluator?}). Prints the diff report JSON.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createCh } from "../src/ch.ts";
import { diffChange } from "../src/registry/promotions.ts";
import { loadRegistry } from "../src/registry/registry.ts";

const { values: a } = parseArgs({
  options: {
    change: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    dependents: { type: "string" },
  },
});
if (!a.change || !a.from || !a.to) throw new Error("--change, --from and --to are required");
const ch = createCh();
const report = await diffChange(
  ch,
  loadRegistry(),
  JSON.parse(readFileSync(a.change, "utf8")),
  { from: a.from, to: a.to },
  a.dependents ? JSON.parse(readFileSync(a.dependents, "utf8")) : undefined,
);
console.log(JSON.stringify(report, null, 2));
await ch.close();
