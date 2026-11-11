import type { RunPort } from "@nearesis/kernel";
import type { RunsService } from "./runs.ts";

/** The production RunPort: marker tasks start real investigations through RunsService (and so Temporal). */
export function runsPort(runs: RunsService): RunPort {
  return {
    async start(session, workspaceId, input) {
      return runs.submitQuestion(
        session,
        workspaceId,
        {
          question: input.question,
          // A replay never claims to read today's live data: it is pinned to the recorded snapshot.
          snapshotPolicy: input.mode === "replay" ? "pinned" : "live",
          budget: input.budget,
        },
        { idempotencyKey: input.idempotencyKey },
      );
    },
    async status(session, runId) {
      const r = await runs.getRun(session, runId);
      return {
        state: r.state,
        terminal: r.terminal,
        succeeded: r.state === "COMPLETE" || r.state === "PARTIAL",
        outputs: r.children
          .filter((c) => c.outputRef)
          .map((c) => ({ taskId: c.taskId, role: c.role, outputRef: String(c.outputRef) })),
      };
    },
  };
}
