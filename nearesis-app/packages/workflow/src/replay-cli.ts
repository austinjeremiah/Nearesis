/** `pnpm --filter @nearesis/workflow replay -- --workflow-id <id>` re-executes a recorded history on the current code. */
import { parseArgs } from "node:util";
import { Worker } from "@temporalio/worker";
import { connectClient } from "./client.ts";
import { WORKFLOWS_PATH } from "./worker.ts";

const { values } = parseArgs({ options: { "workflow-id": { type: "string" }, file: { type: "string" } } });
let history: unknown;
if (values.file) {
  const { readFileSync } = await import("node:fs");
  history = JSON.parse(readFileSync(values.file, "utf8"));
} else {
  if (!values["workflow-id"]) throw new Error("--workflow-id or --file required");
  const client = await connectClient();
  history = await client.workflow.getHandle(values["workflow-id"]).fetchHistory();
}
await Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history, values["workflow-id"]);
console.log("REPLAY_OK deterministic");
process.exit(0);
