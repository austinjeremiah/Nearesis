import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { KernelError, workspaceNotFound, zodDetails } from "@nearesis/kernel";
import type { Kernel, Session, Tx } from "@nearesis/kernel";
import {
  COST_DIMENSIONS,
  SLOS,
  SloRecorder,
  exportLedger,
  readBurn,
  resumeWorkspace,
  sloStatus,
  upsertPolicy,
} from "@nearesis/workflow";
import type { PolicyInput } from "@nearesis/workflow";

export interface CostRoutesOptions {
  kernel: Kernel;
  authenticate(req: FastifyRequest): Promise<Session>;
  /** Optional recorder: every response feeds the `api_availability` SLO (status < 500 is good). */
  slo?: SloRecorder | undefined;
  clock?: () => Date;
}

const Uuid = z.uuid();
const Dim = z.enum(COST_DIMENSIONS);
const PolicyBody = z.strictObject({
  capUsd: z.number().finite().min(0),
  periodDays: z.number().int().min(1).max(366).optional(),
  dimensionLimits: z.partialRecord(Dim, z.number().finite().min(0)).optional(),
  rates: z.partialRecord(Dim, z.number().finite().min(0)).optional(),
  paidOpsPermitted: z.array(z.string().min(1).max(100)).max(50).optional(),
  inflightAllowanceUsd: z.number().finite().min(0).optional(),
  alertThresholds: z.array(z.number().gt(0).max(1)).max(10).optional(),
  alertMaxPerWindow: z.number().int().min(0).max(1000).optional(),
  alertWindowSeconds: z.number().int().min(1).max(604800).optional(),
  alertCooldownSeconds: z.number().int().min(0).max(86400).optional(),
});

/**
 * Cost control and SLO API (ch.13). Contract for the frontend (INTEGRATION_QUEUE):
 *   GET  /v1/workspaces/:id/cost/burn     -> WorkspaceBurn (spend, cap, burn fraction, per-dimension usage, forecast labelled
 *                                            "projection", hard-stop state, block and alert counts)
 *   GET  /v1/workspaces/:id/cost/ledger   -> LedgerExport (metering entries and blocked spends), `?limit=` (default 200)
 *   PUT  /v1/workspaces/:id/cost/policy   -> CostPolicy   (owner/admin; cap, per-dimension limits, paid-op permissions, alert caps)
 *   POST /v1/workspaces/:id/cost/resume   -> { resumed }  (owner/admin; clears a hard stop)
 *   GET  /v1/ops/slo                      -> { slos: SloStatus[] } (multi-window burn state of the declared SLOs)
 * Foreign and unknown workspaces are one 404 (RLS hides foreign rows).
 */
export const costRoutes: FastifyPluginAsync<CostRoutesOptions> = async (app, opts) => {
  const { kernel, authenticate } = opts;
  const now = opts.clock ?? (() => new Date());
  const ctx = (s: Session) => ({ orgId: s.principal.orgId, userId: s.userId });

  async function inWorkspace<T>(
    req: FastifyRequest<{ Params: { id: string } }>,
    admin: boolean,
    fn: (tx: Tx, s: Session, ws: string) => Promise<T>,
  ): Promise<T> {
    const s = await authenticate(req);
    const ws = req.params.id;
    if (!Uuid.safeParse(ws).success) throw workspaceNotFound();
    if (admin && s.role !== "owner" && s.role !== "admin")
      throw new KernelError("FORBIDDEN", "ACCESS_DENIED", "Only an owner or admin may change spend policy.");
    return kernel.db.tx(ctx(s), async (tx) => {
      const w = await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [ws]);
      if (!w.rows[0]) throw workspaceNotFound();
      await tx.query("SELECT set_config('search_path', 'runtime, public', true)");
      return fn(tx, s, ws);
    });
  }
  type R = FastifyRequest<{ Params: { id: string } }>;

  app.get<{ Params: { id: string } }>("/v1/workspaces/:id/cost/burn", (req) =>
    inWorkspace(req as R, false, (tx, s, ws) => readBurn(tx, s.principal.orgId, ws, now())),
  );
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/v1/workspaces/:id/cost/ledger",
    (req) =>
      inWorkspace(req as unknown as R, false, (tx, s, ws) =>
        exportLedger(
          tx,
          s.principal.orgId,
          ws,
          Math.min(Math.max(Number(req.query.limit ?? 200) || 200, 1), 2000),
        ),
      ),
  );
  app.put<{ Params: { id: string } }>("/v1/workspaces/:id/cost/policy", (req) =>
    inWorkspace(req as R, true, async (tx, s, ws) => {
      const p = PolicyBody.safeParse(req.body);
      if (!p.success)
        throw new KernelError("VALIDATION_FAILED", "INVALID_POLICY", "Invalid cost policy.", {
          details: zodDetails(p.error),
        });
      return upsertPolicy(tx, s.principal.orgId, ws, p.data as PolicyInput, now());
    }),
  );
  app.post<{ Params: { id: string } }>("/v1/workspaces/:id/cost/resume", (req) =>
    inWorkspace(req as R, true, async (tx, s, ws) => ({
      resumed: await resumeWorkspace(tx, s.principal.orgId, ws, now()),
    })),
  );
  app.get("/v1/ops/slo", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctx(s), async (tx) => {
      await tx.query("SELECT set_config('search_path', 'runtime, public', true)");
      const slos = [];
      for (const slo of SLOS) slos.push(await sloStatus(tx, slo, now()));
      return { slos };
    });
  });

  if (opts.slo) {
    const rec = opts.slo;
    // Not encapsulated: the availability hook must see every route registered on the root app.
    app.addHook("onResponse", async (_req, reply) => {
      rec.record("api_availability", reply.statusCode < 500);
    });
  }
};
// Make the plugin's hooks apply app-wide (same effect as fastify-plugin).
(costRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
