import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import type { InvestigationWorkflow } from "./workflows.ts";
import { TASK_QUEUE, type InvestigationInput } from "./types.ts";

export async function connectClient(
  address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:57233",
): Promise<Client> {
  return new Client({ connection: await Connection.connect({ address }), namespace: "default" });
}

/** Starts an InvestigationWorkflow. Workflow ID is deterministic in (investigation, question) so a retried submit cannot double-start. */
export async function startInvestigation(
  client: Client,
  input: Omit<InvestigationInput, "runId"> & { runId?: string },
  opts: { taskQueue?: string } = {},
): Promise<{ runId: string; workflowId: string }> {
  const runId = input.runId ?? randomUUID();
  const workflowId = `investigation-${input.investigationId}-${input.questionId}`;
  await client.workflow.start<typeof InvestigationWorkflow>("InvestigationWorkflow", {
    taskQueue: opts.taskQueue ?? TASK_QUEUE,
    workflowId,
    workflowIdReusePolicy: "REJECT_DUPLICATE",
    args: [{ ...input, runId }],
  });
  return { runId, workflowId };
}
