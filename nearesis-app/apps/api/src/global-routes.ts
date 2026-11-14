import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  GlobalApprovalList,
  GlobalMetricList,
  GlobalNotificationList,
  GlobalSourceList,
  MeResponse,
  PublicationList,
} from "@nearesis/contracts";
import { KernelError, canAdmin, canWrite, microToUsd } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import type { AuthoringService } from "@nearesis/semantic-gateway";
import {
  APP_ROOT,
  isCapsulePublic,
  readCapsuleOwnership,
  readCapsulePublicationState,
  readManifest,
} from "@nearesis/capsule";
import type { RunsService } from "./runs.ts";
import { usdCreditsOf } from "./usd-credits-api.ts";
import { createSourceHealthPort, type SourceHealthPort } from "./source-health.ts";

export interface GlobalRoutesOptions {
  kernel: Kernel;
  authenticate(req: FastifyRequest): Promise<Session>;
  runs: RunsService;
  authoring?: AuthoringService | undefined;
  /** Test seam. Default: ingestion's recorded state in the live ClickHouse database. */
  sources?: SourceHealthPort;
  /** Capsule store (default NEARESIS_CAPSULE_DIR, else <app>/.data/capsules), same as the capsule routes. */
  capsuleRoot?: () => string;
}

const CAPSULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
/** Fan-out lists read at most this many workspaces (the newest); `truncated` says when more exist. */
const MAX_WORKSPACES = 100;
const CONCURRENCY = 6;

async function mapLimited<T, R>(xs: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, xs.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= xs.length) return;
        out[i] = await fn(xs[i]!);
      }
    }),
  );
  return out;
}

const ListQ = z.object({
  unread: z.enum(["1", "true", "0", "false"]).optional(),
  status: z.enum(["pending", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * Identity and global (cross-workspace) reads for a frontend that has no workspace in hand yet. Every list is computed from
 * the workspaces the caller can already read (RLS-scoped), so nothing outside the caller's org can appear:
 *   GET /v1/me              principal, org, role, workspaces
 *   GET /v1/notifications   monitor notifications of all workspaces, newest first (?unread=1, ?limit=)
 *   GET /v1/approvals       approvals of all runs (?status=pending|all, default pending)
 *   GET /v1/publications    capsules of the org with their publication state
 *   GET /v1/metrics         metric catalogue: registry plus authored metrics of all workspaces, with status
 *   GET /v1/sources         source health from ingestion (platform-wide state, no tenant data)
 */
export const globalRoutes: FastifyPluginAsync<GlobalRoutesOptions> = async (app, opts) => {
  const { kernel, authenticate, runs } = opts;
  let sources: SourceHealthPort | null = opts.sources ?? null;
  app.addHook("onClose", async () => {
    if (!opts.sources) await sources?.close();
  });
  const capsuleRoot =
    opts.capsuleRoot ?? (() => process.env.NEARESIS_CAPSULE_DIR ?? join(APP_ROOT, ".data", "capsules"));

  const workspacesOf = async (s: Session) => {
    const l = (await runs.listWorkspaces(s)).workspaces;
    return { list: l, truncated: l.length >= MAX_WORKSPACES };
  };
  const parseQ = (q: unknown) => {
    const r = ListQ.safeParse(q);
    if (!r.success) throw new KernelError("VALIDATION_FAILED", "INVALID_QUERY", "Invalid query.");
    return r.data;
  };

  app.get("/v1/me", async (req) => {
    const s = await authenticate(req);
    const info = await kernel.db.tx({ orgId: s.principal.orgId, userId: s.userId }, async (tx) => {
      const org = (
        await tx.query<{ id: string; name: string }>("SELECT id, name FROM organizations WHERE id = $1", [
          s.principal.orgId,
        ])
      ).rows[0];
      const user = (
        await tx.query<{ display_name: string | null; near_account_id: string | null }>(
          "SELECT display_name, near_account_id FROM users WHERE id = $1",
          [s.userId],
        )
      ).rows[0];
      return { org, user };
    });
    const ws = (await workspacesOf(s)).list;
    const usd = usdCreditsOf(kernel.db);
    await usd.reconcileRuns(s.userId).catch(() => undefined);
    const acct = await usd.account({ orgId: s.principal.orgId, userId: s.userId });
    const body: MeResponse & { credits: { availableUsd: string; allowanceUsd: string; exhausted: boolean } } =
      {
        principal: { userId: s.userId, kind: s.principal.kind, displayName: info.user?.display_name ?? null },
        org: { id: s.principal.orgId, name: info.org?.name ?? "" },
        nearAccountId: info.user?.near_account_id ?? null,
        role: s.role,
        roles: [s.role],
        permissions: { canWrite: canWrite(s.role), canAdmin: canAdmin(s.role) },
        workspaces: ws,
        credits: {
          availableUsd: microToUsd(acct.availableMicro),
          allowanceUsd: microToUsd(acct.grantedMicro),
          exhausted: acct.availableMicro <= 0n,
        },
      };
    return body;
  });

  app.get("/v1/notifications", async (req) => {
    const s = await authenticate(req);
    const q = parseQ(req.query);
    const unreadOnly = q.unread === "1" || q.unread === "true";
    const limit = q.limit ?? 200;
    const { list, truncated } = await workspacesOf(s);
    const per = await mapLimited(list, async (w) => ({
      w,
      rows: await kernel.monitoring.listNotifications(s, w.id, unreadOnly, 100),
    }));
    const all = per.flatMap(({ w, rows }) => rows.map((n) => ({ w, n })));
    all.sort((a, b) => (a.n.createdAt < b.n.createdAt ? 1 : a.n.createdAt > b.n.createdAt ? -1 : 0));
    const body: GlobalNotificationList = {
      notifications: all.slice(0, limit).map(({ w, n }) => ({
        notificationId: n.notificationId,
        workspaceId: n.workspaceId,
        workspaceObjective: w.objective,
        ruleId: n.ruleId,
        triggerId: n.triggerId,
        markerId: n.markerId,
        mode: n.mode,
        title: n.title,
        body: n.body,
        createdAt: n.createdAt,
        readAt: n.readAt,
      })),
      unread: all.filter(({ n }) => n.readAt === null).length,
      truncated: truncated || all.length > limit || per.some((p) => p.rows.length >= 100),
      workspaceCount: list.length,
    };
    return body;
  });

  const ReadBody = z.union([
    z.strictObject({ ids: z.array(z.uuid()).min(1).max(500) }),
    z.strictObject({ all: z.literal(true) }),
  ]);
  const readBody = (b: unknown) => {
    const r = ReadBody.safeParse(b);
    if (!r.success)
      throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Send { ids: [uuid...] } or { all: true }.");
    return r.data;
  };
  const unreadIn = async (s: Session, ids: string[]) => {
    const per = await mapLimited(ids, async (id) => kernel.monitoring.listNotifications(s, id, true, 100));
    return per.reduce((a, rows) => a + rows.length, 0);
  };

  /**
   * Marks notifications read for the CALLING USER only (per-user state; other members still see them unread). Ids of other
   * tenants or unknown ids are reported under notFound, identical for both. `unread` is the caller's count after the
   * change, computed exactly as GET /v1/notifications does.
   */
  app.post("/v1/notifications/read", async (req) => {
    const s = await authenticate(req);
    const which = readBody(req.body);
    const { list } = await workspacesOf(s);
    const marked: string[] = [];
    let alreadyRead = 0;
    let remaining = "ids" in which ? new Set(which.ids) : new Set<string>();
    for (const w of list) {
      const r = await kernel.monitoring.markNotificationsRead(
        s,
        w.id,
        "ids" in which ? { ids: which.ids } : { all: true },
      );
      marked.push(...r.marked);
      alreadyRead += r.alreadyRead;
      if ("ids" in which) remaining = new Set([...remaining].filter((i) => r.notFound.includes(i)));
    }
    return {
      marked,
      alreadyRead,
      notFound: [...remaining],
      unread: await unreadIn(
        s,
        list.map((w) => w.id),
      ),
    };
  });

  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/notifications/read", async (req) => {
    const s = await authenticate(req);
    const id = req.params.id;
    if (!z.uuid().safeParse(id).success) throw new KernelError("NOT_FOUND", "NOT_FOUND", "Not found.");
    const which = readBody(req.body);
    try {
      const r = await kernel.monitoring.markNotificationsRead(s, id, which);
      return { ...r, unread: await unreadIn(s, [id]) };
    } catch (e) {
      if (e instanceof KernelError && e.reasonCode === "ACCESS_DENIED")
        throw new KernelError("NOT_FOUND", "NOT_FOUND", "Not found.");
      throw e;
    }
  });

  app.get("/v1/approvals", async (req) => {
    const s = await authenticate(req);
    const status = parseQ(req.query).status ?? "pending";
    const { list, truncated } = await workspacesOf(s);
    const byId = new Map(list.map((w) => [w.id, w]));
    const wanted = list.map((w) => w.id);
    // Runs with an approval, newest first. RLS on workspaces and runtime.runs limits this to the caller's org.
    const runRows = wanted.length
      ? await kernel.db
          .tx({ orgId: s.principal.orgId, userId: s.userId }, async (tx) => {
            const r = await tx.query<{ id: string; workspace_id: string; state: string }>(
              status === "pending"
                ? `SELECT r.id, r.workspace_id, r.state FROM runtime.runs r
                    WHERE r.state = 'APPROVAL_NEEDED' AND r.workspace_id = ANY($1::uuid[])
                    ORDER BY r.updated_at DESC LIMIT 200`
                : `SELECT r.id, r.workspace_id, r.state FROM runtime.runs r
                    WHERE r.workspace_id = ANY($1::uuid[])
                      AND EXISTS (SELECT 1 FROM runtime.run_events e WHERE e.run_id = r.id AND e.source = 'run' AND e.kind = 'approval.requested')
                    ORDER BY r.updated_at DESC LIMIT 100`,
              [wanted],
            );
            return r.rows;
          })
          .catch((e: unknown) => {
            const c = (e as { code?: string } | null)?.code;
            if (c === "42P01" || c === "3F000" || c === "42501") return [];
            throw e;
          })
      : [];
    const per = await mapLimited(runRows, async (r) => ({ r, v: await runs.listApprovals(s, r.id, status) }));
    const approvals = per.flatMap(({ r, v }) =>
      v.approvals.map((a) => ({
        approvalId: a.approvalId,
        runId: r.id,
        workspaceId: r.workspace_id,
        workspaceObjective: byId.get(r.workspace_id)?.objective ?? "",
        runState: v.state,
        actionHash: a.actionHash,
        status: a.status,
        kind: a.kind,
        network: a.network,
        costLimit: a.costLimit,
        requestedAt: a.requestedAt,
        decidedBy: a.decidedBy,
        decidedAt: a.decidedAt,
      })),
    );
    approvals.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
    const body: GlobalApprovalList = { approvals, truncated, workspaceCount: list.length };
    return body;
  });

  /**
   * GET /v1/findings: the newest interpreted findings (analyst + skeptic, grounded in result cells) across the caller's
   * non-archived workspaces, one or more per run, newest run first. Each finding is returned exactly as stored, with the
   * run's question and workspace so a reader can open the evidence. Read-only; no model call is made here.
   */
  app.get("/v1/findings", async (req) => {
    const s = await authenticate(req);
    const limit = Math.min(parseQ(req.query).limit ?? 6, 50);
    const { list, truncated } = await workspacesOf(s);
    const byId = new Map(list.map((w) => [w.id, w]));
    const wanted = list.map((w) => w.id);
    const rows = wanted.length
      ? await kernel.db
          .tx({ orgId: s.principal.orgId, userId: s.userId }, async (tx) => {
            const r = await tx.query<{
              run_id: string;
              workspace_id: string;
              finding: Record<string, unknown>;
              created_at: Date;
              question: string | null;
              scenario: string | null;
            }>(
              `SELECT f.run_id, f.workspace_id, f.finding, f.created_at, r.scenario,
                      (SELECT t.objective FROM runtime.tasks t WHERE t.run_id = r.id AND t.objective IS NOT NULL
                        ORDER BY t.depth, t.created_at, t.id LIMIT 1) AS question
                 FROM runtime.run_findings f JOIN runtime.runs r ON r.id = f.run_id
                WHERE f.workspace_id = ANY($1::uuid[])
                ORDER BY f.created_at DESC, f.position ASC LIMIT $2`,
              [wanted, limit],
            );
            return r.rows;
          })
          .catch((e: unknown) => {
            const c = (e as { code?: string } | null)?.code;
            if (c === "42P01" || c === "3F000" || c === "42501") return [];
            throw e;
          })
      : [];
    return {
      findings: rows.map((r) => ({
        runId: r.run_id,
        workspaceId: r.workspace_id,
        workspaceObjective: byId.get(r.workspace_id)?.objective ?? "",
        question: (r.question ?? r.scenario ?? "").replace(/^\[scenario=[^\]]*\]\s*/, "").slice(0, 300),
        createdAt: new Date(r.created_at).toISOString(),
        finding: r.finding,
      })),
      truncated,
      workspaceCount: list.length,
    };
  });

  app.get("/v1/publications", async (req) => {
    const s = await authenticate(req);
    const dir = capsuleRoot();
    const ids = existsSync(dir) ? readdirSync(dir).sort() : [];
    const readable = new Map<string, boolean>();
    const out: PublicationList["publications"] = [];
    for (const id of ids) {
      if (!CAPSULE_ID.test(id)) continue;
      const d = join(dir, id);
      if (!existsSync(join(d, "manifest.json"))) continue;
      // Same tenant gate as the capsule routes: the ownership record must name the caller's org and a readable workspace.
      const owner = readCapsuleOwnership(d);
      if (!owner || owner.orgId !== s.principal.orgId) continue;
      if (!readable.has(owner.workspaceId))
        readable.set(
          owner.workspaceId,
          await kernel.workspaces.get(s, owner.workspaceId).then(
            () => true,
            (e: unknown) => {
              if (e instanceof KernelError) return false;
              throw e;
            },
          ),
        );
      if (!readable.get(owner.workspaceId)) continue;
      const m = readManifest(d);
      if (!m) continue;
      const rec = readCapsulePublicationState(d);
      const isPublic = isCapsulePublic(d);
      out.push({
        capsuleId: m.capsuleId,
        title: m.title,
        label: m.label,
        createdAt: m.createdAt ?? null,
        workspaceId: owner.workspaceId,
        state: isPublic ? "published" : rec ? "unpublished" : "never_published",
        public: isPublic,
        badge: rec?.badge ?? null,
        publishedAt: rec?.state === "published" ? rec.at : null,
        acknowledged: rec?.acknowledged ?? [],
      });
    }
    out.sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1));
    const body: PublicationList = { publications: out };
    return body;
  });

  app.get("/v1/metrics", async (req) => {
    const s = await authenticate(req);
    if (!opts.authoring)
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "METRIC_CATALOGUE_UNAVAILABLE",
        "The metric catalogue is not configured on this API.",
        {
          retryable: true,
        },
      );
    const { list, truncated } = await workspacesOf(s);
    const per = await mapLimited(list, async (w) => ({
      w,
      rows: await opts.authoring!.catalogue({
        id: s.userId,
        kind: "human",
        role: s.role,
        tenantId: s.principal.orgId,
        workspaceId: w.id,
      }),
    }));
    const merged = new Map<string, GlobalMetricList["metrics"][number]>();
    for (const { w, rows } of per)
      for (const m of rows) {
        const k =
          m.source === "registry"
            ? `registry:${m.metricKey}`
            : `authored:${m.metricKey}@${m.version}:${m.status}`;
        const have = merged.get(k);
        if (have) {
          if (m.source === "authored" && !have.authoredIn.includes(w.id)) have.authoredIn.push(w.id);
          continue;
        }
        merged.set(k, {
          metricKey: m.metricKey,
          source: m.source,
          status: m.status,
          version: m.version ?? null,
          displayName: m.displayName ?? null,
          unit: m.unit ?? null,
          exploratory: m.exploratory,
          authoredIn: m.source === "authored" ? [w.id] : [],
        });
      }
    const metrics = [...merged.values()].sort((a, b) =>
      a.metricKey < b.metricKey
        ? -1
        : a.metricKey > b.metricKey
          ? 1
          : String(a.version ?? "").localeCompare(String(b.version ?? ""), undefined, { numeric: true }),
    );
    const counts: Record<string, number> = {};
    for (const m of metrics) counts[m.status] = (counts[m.status] ?? 0) + 1;
    const body: GlobalMetricList = { metrics, counts, truncated, workspaceCount: list.length };
    return body;
  });

  app.get("/v1/sources", async (req) => {
    await authenticate(req);
    sources ??= createSourceHealthPort();
    const asOf = new Date().toISOString();
    try {
      const body: GlobalSourceList = { sources: await sources.read(), asOf, unavailable: null };
      return body;
    } catch {
      const body: GlobalSourceList = {
        sources: [],
        asOf,
        unavailable: {
          reasonCode: "SOURCE_HEALTH_UNAVAILABLE",
          message: "Source health could not be read from ingestion.",
        },
      };
      return body;
    }
  });
};

(globalRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
