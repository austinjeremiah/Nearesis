import { createHash } from "node:crypto";
import { KernelCanvasExecutor, type RequesterResolver } from "@nearesis/agent-runtime";
import { historyService, type Kernel } from "@nearesis/kernel";
import { interpreterActorId, type FindingSink } from "./interpretation.ts";

/** Deterministic uuid (v5 shaped) so a replayed publish addresses the same nodes and commands. */
const uuidOf = (seed: string): string => {
  const h = createHash("sha256").update(seed).digest("hex");
  const v = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${v}${h.slice(18, 20)}-${h.slice(20, 32)}`;
};

/**
 * Publishes interpretation findings through the kernel: each finding becomes an evidence-graph `claim` that is
 * `derived_from` the query node(s) of the panels it was read from (with the result columns and row ids as provenance), and a
 * `finding.created` domain event goes out on the workspace SSE stream. Every command has a deterministic id, so a retried
 * publish replays instead of duplicating. The principal is the run's interpreter agent acting for the requesting human.
 */
export class KernelFindingSink implements FindingSink {
  constructor(
    private readonly kernel: Kernel,
    private readonly requesterOf: RequesterResolver,
  ) {}

  async publish(a: Parameters<FindingSink["publish"]>[0]): Promise<void> {
    const requester = await this.requesterOf(a.tenantId, a.runId);
    if (!requester) return;
    const session = new KernelCanvasExecutor(this.kernel).sessionFor({
      tenantId: a.tenantId,
      runId: a.runId,
      agentActorId: interpreterActorId(a.runId),
      requester,
    });
    const graph = historyService(this.kernel).graphOps;
    const version = async (): Promise<number> =>
      (await this.kernel.workspaces.get(session, a.workspaceId)).version;

    const queryNode = new Map<string, string>();
    for (const q of a.queries) {
      const id = uuidOf(`finding-query:${a.runId}:${q.queryHash}`);
      queryNode.set(q.queryHash, id);
      const commandId = uuidOf(`finding-cmd:${a.runId}:qnode:${q.queryHash}`);
      await graph.addNode(session, a.workspaceId, {
        commandId,
        expectedVersion: await version(),
        nodeId: id,
        kind: "query",
        label: `${q.title} (query ${q.queryHash.slice(0, 12)})`.slice(0, 500),
        data: {
          queryHash: q.queryHash,
          semanticVersion: q.semanticVersion,
          panelId: q.panelId,
          certification: q.certification,
        },
      });
    }

    for (const [index, f] of a.findings.entries()) {
      const refs = f.facts.map((x) => x.resultRef);
      const hashes = [...new Set(refs.map((r) => r.queryHash))];
      await graph.addNode(session, a.workspaceId, {
        commandId: uuidOf(`finding-cmd:${a.runId}:claim:${f.id}`),
        expectedVersion: await version(),
        nodeId: f.id,
        kind: "claim",
        label: f.statement.slice(0, 500),
        data: {
          numeric: true,
          findingKind: f.kind,
          basis: f.basis,
          status: f.status,
          limitations: f.limitations.slice(0, 20),
          skepticNotes: f.skepticNotes.slice(0, 20),
          provenance: {
            queryHash: hashes[0],
            resultRowIds: [...new Set(refs.flatMap((r) => r.rowIds))].slice(0, 200),
            columnIds: [...new Set(refs.map((r) => r.column))],
            semanticModelVersion: refs[0]?.semanticVersion,
          },
          tier: "exploratory",
        },
      });
      for (const h of hashes) {
        const to = queryNode.get(h);
        if (!to) continue;
        await graph.addEdge(session, a.workspaceId, {
          commandId: uuidOf(`finding-cmd:${a.runId}:edge:${f.id}:${h}`),
          expectedVersion: await version(),
          from: f.id,
          to,
          relation: "derived_from",
          reason: "numbers recomputed from this query's result rows",
        });
      }
      // finding.created: one SSE frame per finding (the statement is re-read from the run, not repeated here)
      const ctx = { orgId: a.tenantId, userId: session.userId, actorKind: session.principal.kind };
      await this.kernel.db.tx(ctx, async (tx) => {
        await tx.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [a.workspaceId]);
        await this.kernel.journal.append(tx, {
          orgId: a.tenantId,
          workspaceId: a.workspaceId,
          type: "finding.created",
          actorId: session.userId,
          causationId: a.runId,
          data: {
            runId: a.runId,
            findingId: f.id,
            kind: f.kind,
            basis: f.basis,
            status: f.status,
            index,
            total: a.findings.length,
          },
        });
      });
    }
  }
}
