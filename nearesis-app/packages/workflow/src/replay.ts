import { readFileSync } from "node:fs";
import { historyFromJSON } from "@temporalio/common/lib/proto-utils";
import { Worker } from "@temporalio/worker";
import { WORKFLOWS_PATH } from "./worker.ts";

export interface ReplayOutcome {
  file: string;
  workflowId: string;
  ok: boolean;
  error: string | null;
}

/** Replays exported histories on the current workflow code (Worker.runReplayHistories); no activities are executed. */
export async function replayFiles(
  files: Array<{ file: string; workflowId: string }>,
  workflowsPath: string = WORKFLOWS_PATH,
): Promise<ReplayOutcome[]> {
  const byId = new Map(files.map((f) => [f.workflowId, f.file]));
  const iter = (async function* () {
    for (const f of files)
      yield { workflowId: f.workflowId, history: historyFromJSON(JSON.parse(readFileSync(f.file, "utf8"))) };
  })();
  const out: ReplayOutcome[] = [];
  for await (const r of Worker.runReplayHistories({ workflowsPath }, iter)) {
    out.push({
      file: byId.get(r.workflowId ?? "") ?? "?",
      workflowId: r.workflowId ?? "?",
      ok: !r.error,
      error: r.error ? `${r.error.name}: ${r.error.message}`.slice(0, 400) : null,
    });
  }
  return out;
}
