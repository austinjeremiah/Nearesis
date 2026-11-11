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
        // Fail closed: only a COMPLETE run produces evidence for a marker. A PARTIAL run (for example an abstention because a
        // required metric is not in the catalog) is a visible non-success with the run's own reason code.
        succeeded: r.state === "COMPLETE",
        failure:
          r.failure && typeof (r.failure as { reasonCode?: unknown }).reasonCode === "string"
            ? { reasonCode: (r.failure as { reasonCode: string }).reasonCode }
            : null,
        outputs: r.children
          .filter((c) => c.outputRef)
          .map((c) => ({ taskId: c.taskId, role: c.role, outputRef: String(c.outputRef) })),
      };
    },
  };
}
