import { CreateSummaryRequest, SetClaimTierRequest } from "@nearesis/contracts";
import type { Session } from "../auth.ts";
import type { Db } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { noWorkspaceAccess } from "../workspace.ts";
import type { CommandOpts } from "./graph-ops.ts";
import { HistoryRunner, idFor, parseBody } from "./runner.ts";

/**
 * Summaries are working notes, kept apart from canonical evidence (ch.10 "Temporal memory and human history"). They
 * never appear in `evidence_nodes`, may go stale when a semantic version they were written against changes, and every
 * recalled item must resolve to authoritative evidence before it can be cited.
 */
export class SummaryOps {
  constructor(
    private readonly db: Db,
    private readonly runner: HistoryRunner,
  ) {}

  private ctx(s: Session) {
    return { orgId: s.principal.orgId, userId: s.userId, actorKind: s.principal.kind };
  }

  async create(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(CreateSummaryRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "summary.create",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        const id = idFor(ctx.commandId, "summary");
        await ctx.tx.query(
          `INSERT INTO history_summaries(id, org_id, workspace_id, author_id, author_kind, body, source_refs, metric_pins)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            ctx.workspace.orgId,
            ctx.workspace.id,
            ctx.session.userId,
            ctx.session.principal.kind,
            p.body,
            JSON.stringify(p.sourceRefs),
            JSON.stringify(p.metricPins),
          ],
        );
        return {
          eventType: "workspace.updated",
          data: { change: "summary.created", summaryId: id, authorKind: ctx.session.principal.kind },
          result: { summaryId: id },
        };
      },
    });
  }

  /**
   * Recall for an agent tool: each item is resolved against authoritative evidence. A summary with no source, or whose
   * sources no longer resolve to live evidence, is returned flagged and `citable: false`.
   */
  async recall(session: Session, workspaceId: string) {
    return this.db.tx(this.ctx(session), async (tx) => {
      const ws = (await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
      if (!ws) throw noWorkspaceAccess();
      const rows = (
        await tx.query<{
          id: string;
          body: string;
          source_refs: string[];
          stale: boolean;
          stale_reason: string | null;
          author_kind: string;
        }>(
          "SELECT id, body, source_refs, stale, stale_reason, author_kind FROM history_summaries WHERE workspace_id = $1 ORDER BY created_at, id",
          [workspaceId],
        )
      ).rows;
      const out = [];
      for (const r of rows) {
        const refs = r.source_refs;
        const live = refs.length
          ? (
              await tx.query<{ id: string }>(
                "SELECT id FROM evidence_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND tombstone = false",
                [workspaceId, refs],
              )
            ).rows.map((x) => x.id)
          : [];
        const unresolved = refs.filter((x) => !live.includes(x));
        const resolved = refs.length > 0 && unresolved.length === 0;
        out.push({
          summaryId: r.id,
          body: r.body,
          authorKind: r.author_kind,
          stale: r.stale,
          staleReason: r.stale_reason,
          sourceRefs: refs,
          evidenceStatus: resolved ? ("resolved" as const) : ("evidence_unresolved" as const),
          unresolvedRefs: refs.length === 0 ? ["<no source>"] : unresolved,
          citable: resolved,
        });
      }
      return out;
    });
  }

  /** The agent tool may cite a summary only through a source it resolves to; a bare summary is not a citation. */
  async cite(session: Session, workspaceId: string, summaryId: string) {
    const items = await this.recall(session, workspaceId);
    const it = items.find((x) => x.summaryId === summaryId);
    if (!it) throw new KernelError("NOT_FOUND", "SUMMARY_NOT_FOUND", "No such summary.");
    if (!it.citable) {
      await this.audit(
        session,
        workspaceId,
        "summary.citation_rejected",
        summaryId,
        "SUMMARY_WITHOUT_SOURCE",
      );
      throw new KernelError(
        "DOMAIN_INVARIANT",
        "SUMMARY_WITHOUT_SOURCE",
        "A summary without resolvable authoritative evidence cannot be cited.",
      );
    }
    return { summaryId, citedEvidence: it.sourceRefs };
  }

  /**
   * Confidence tier of a claim. Memory and summaries can never raise it (ch.10: memory "may not ... silently upgrade
   * confidence"): an upgrade must rest on live evidence, and an upgrade requested on the basis of memory is refused
   * and audited. Downgrades are always allowed.
   */
  async setClaimTier(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(SetClaimTierRequest, body);
    const rank = (t: string) => (t === "out_of_sample" ? 1 : 0);
    try {
      return await this.runner.run(session, workspaceId, {
        commandType: "claim.set_tier",
        commandId: p.commandId,
        idempotencyKey: opts.idempotencyKey,
        expectedVersion: p.expectedVersion,
        payload: p,
        handle: async (ctx) => {
          const cur = (
            await ctx.tx.query<{ kind: string; data: Record<string, unknown> }>(
              "SELECT kind, data FROM evidence_nodes WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
              [p.nodeId, ctx.workspace.id],
            )
          ).rows[0];
          if (!cur || cur.kind !== "claim")
            throw new KernelError("NOT_FOUND", "CLAIM_NOT_FOUND", "No such claim.");
          const from = typeof cur.data.evidenceTier === "string" ? cur.data.evidenceTier : "exploratory";
          if (rank(p.toTier) > rank(from)) {
            if (p.basis.kind === "memory")
              throw new KernelError(
                "DOMAIN_INVARIANT",
                "MEMORY_CANNOT_UPGRADE_CONFIDENCE",
                "Confidence cannot be raised on the basis of memory or a summary.",
              );
            const ev = (
              await ctx.tx.query<{ data: Record<string, unknown> }>(
                `SELECT data FROM evidence_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])
                  AND kind = 'statistical_result' AND tombstone = false`,
                [ctx.workspace.id, p.basis.nodeIds],
              )
            ).rows;
            if (!ev.some((e) => e.data.evaluation === "out_of_sample"))
              throw new KernelError(
                "DOMAIN_INVARIANT",
                "UPGRADE_NEEDS_OUT_OF_SAMPLE_EVIDENCE",
                "An out-of-sample tier needs a live out-of-sample statistical result.",
              );
          }
          await ctx.tx.query("UPDATE evidence_nodes SET data = $2 WHERE id = $1", [
            p.nodeId,
            JSON.stringify({ ...cur.data, evidenceTier: p.toTier }),
          ]);
          return {
            eventType: "claim.updated",
            data: {
              change: "graph.node_data_updated",
              nodeId: p.nodeId,
              keys: ["evidenceTier"],
              patch: { evidenceTier: p.toTier },
              reason: `tier ${from} -> ${p.toTier}`,
            },
            result: { nodeId: p.nodeId, from, to: p.toTier },
          };
        },
      });
    } catch (e) {
      // The refusal itself is evidence: audited outside the rolled-back command transaction.
      if (e instanceof KernelError && e.code !== "FORBIDDEN" && e.reasonCode !== "STALE_VERSION")
        await this.audit(session, workspaceId, "claim.tier_change_rejected", p.nodeId, e.reasonCode);
      throw e;
    }
  }

  async audit(session: Session, workspaceId: string, action: string, subject: string, reason: string) {
    await this.db.tx(this.ctx(session), (tx) =>
      tx.query(
        `INSERT INTO audit_events(id, org_id, workspace_id, actor_id, action, subject, outcome, reason_code, detail)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'rejected', $6, $7)`,
        [
          session.principal.orgId,
          workspaceId,
          session.userId,
          action,
          subject,
          reason,
          JSON.stringify({ actorKind: session.principal.kind }),
        ],
      ),
    );
  }
}
