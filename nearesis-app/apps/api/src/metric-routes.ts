import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { KernelError, workspaceNotFound } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import { MetricAuthoringError } from "@nearesis/semantic-gateway";
import type { AuthoringPrincipal, AuthoringService } from "@nearesis/semantic-gateway";

export interface MetricRoutesOptions {
  kernel: Kernel;
  authenticate(req: FastifyRequest): Promise<Session>;
  /** The authoring service (store, ClickHouse, catalogue). Wired by the API composition root. */
  authoring: AuthoringService;
}

const Uuid = z.uuid();
const Key = z.string().regex(/^[a-z][a-z0-9_]{1,31}\.[a-z][a-z0-9_]{1,63}$/);
const Version = z.coerce.number().int().positive().max(100000);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ProposeBody = z.strictObject({
  proposal: z.record(z.string(), z.unknown()),
  validate: z.boolean().optional(),
});
const ReviseBody = z.strictObject({ proposal: z.record(z.string(), z.unknown()) });
const DeprecateBody = z.strictObject({
  reason: z.string().min(5).max(1000),
  /** V18 correction flow: record every dependent snapshot and metric as invalidated. */
  correction: z.boolean().optional(),
});
const ExploreBody = z.strictObject({ from: Day.optional(), to: Day.optional() }).optional();
const rangeOf = (b: z.infer<typeof ExploreBody>) =>
  b?.from && b.to ? { from: b.from, to: b.to } : undefined;
const PinBody = z.strictObject({
  snapshotId: z.string().min(1).max(200),
  metrics: z
    .array(z.strictObject({ metricKey: Key, version: z.number().int().positive() }))
    .min(1)
    .max(50),
});
const PublishCheckBody = z.strictObject({
  metrics: z
    .array(z.strictObject({ metricKey: Key, version: z.number().int().positive().optional() }))
    .min(1)
    .max(100),
});

/**
 * Governed metric authoring API (final_master_prompt section 4). Contract for the frontend (INTEGRATION_QUEUE):
 *   GET  /v1/workspaces/:id/metrics                                  -> { metrics: [{metricKey, source: registry|authored, status, version, unit, displayName, exploratory}] }
 *   POST /v1/workspaces/:id/metrics/proposals {proposal, validate?}  -> 201 {record, report}   (DRAFT, then VALIDATED when the gate passes; author = caller)
 *   GET  /v1/workspaces/:id/metrics/:key/versions                    -> {versions, audit, corrections}
 *   GET  /v1/workspaces/:id/metrics/:key/versions/:v                 -> MetricRecord
 *   PUT  /v1/workspaces/:id/metrics/:key/versions/:v {proposal}      -> {record, report}   (never-certified drafts only)
 *   POST .../versions/:v/validate                                    -> {record, report}
 *   POST .../versions/:v/certify                                     -> MetricRecord  (human owner/admin only)
 *   POST .../versions/:v/deprecate {reason, correction?}             -> {record, invalidated}  (human owner/admin only)
 *   POST /v1/workspaces/:id/metrics/:key/revisions {proposal}        -> 201 {record, report}   (new version of a certified metric)
 *   POST .../versions/:v/explore {from,to}? | POST .../explore      -> {envelope, record}  (envelope.metricStatus + envelope.exploratory.banner for non-certified)
 *   POST /v1/workspaces/:id/metrics/pins {snapshotId, metrics[]}     -> {pins}  (certified versions only)
 *   GET  /v1/workspaces/:id/metrics/pins/:snapshotId                 -> {pins}
 *   POST /v1/workspaces/:id/metrics/publish-check {metrics[]}        -> 200 {publishable:true} | 422 METRIC_NOT_CERTIFIED with details
 * Errors are ErrorResponse with reasonCode from MetricAuthoringReason (details carry the failing paths).
 * Foreign and unknown workspaces are one 404.
 */
export const metricRoutes: FastifyPluginAsync<MetricRoutesOptions> = async (app, opts) => {
  const { kernel, authenticate, authoring } = opts;

  async function guard<T>(
    req: FastifyRequest<{ Params: { id: string } }>,
    fn: (p: AuthoringPrincipal, s: Session) => Promise<T>,
  ): Promise<T> {
    const s = await authenticate(req);
    const ws = req.params.id;
    if (!Uuid.safeParse(ws).success) throw workspaceNotFound();
    await kernel.db.tx({ orgId: s.principal.orgId, userId: s.userId }, async (tx) => {
      const w = await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [ws]);
      if (!w.rows[0]) throw workspaceNotFound();
    });
    const principal: AuthoringPrincipal = {
      id: s.userId,
      kind: "human",
      role: s.role,
      tenantId: s.principal.orgId,
      workspaceId: ws,
    };
    try {
      return await fn(principal, s);
    } catch (e) {
      if (e instanceof MetricAuthoringError)
        throw new KernelError(e.errorCode, e.reason, e.message, {
          details: e.issues.map((i) => ({ path: i.path, issue: `${i.reason}: ${i.message}` })),
        });
      throw e;
    }
  }
  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const r = schema.safeParse(body);
    if (!r.success)
      throw new KernelError("VALIDATION_FAILED", "INVALID_PROPOSAL", "Invalid request body.", {
        details: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), issue: i.message })),
      });
    return r.data;
  };
  const key = (k: string) => {
    if (!Key.safeParse(k).success) throw new KernelError("NOT_FOUND", "NOT_FOUND", "No such metric.");
    return k;
  };
  const ver = (v: string) => {
    const r = Version.safeParse(v);
    if (!r.success) throw new KernelError("NOT_FOUND", "NOT_FOUND", "No such metric version.");
    return r.data;
  };
  /** The author is a server-side fact: whatever the body says is replaced by the session principal. */
  const withAuthor = (p: AuthoringPrincipal, proposal: Record<string, unknown>) => ({
    ...proposal,
    author: { principalId: p.id, kind: p.kind, tenantId: p.tenantId },
  });
  type W = { Params: { id: string } };
  type WK = { Params: { id: string; key: string } };
  type WKV = { Params: { id: string; key: string; v: string } };

  app.get<W>("/v1/workspaces/:id/metrics", (req) =>
    guard(req, async (p) => ({ metrics: await authoring.catalogue(p) })),
  );
  app.post<W>("/v1/workspaces/:id/metrics/proposals", (req, reply) =>
    guard(req, async (p) => {
      const b = parse(ProposeBody, req.body);
      const r = await authoring.propose(p, withAuthor(p, b.proposal), { validate: b.validate !== false });
      return reply.status(201).send(r);
    }),
  );
  app.get<WK>("/v1/workspaces/:id/metrics/:key/versions", (req) =>
    guard(req, (p) => authoring.versions(p, key(req.params.key))),
  );
  app.get<WKV>("/v1/workspaces/:id/metrics/:key/versions/:v", (req) =>
    guard(req, (p) => authoring.get(p, key(req.params.key), ver(req.params.v))),
  );
  app.put<WKV>("/v1/workspaces/:id/metrics/:key/versions/:v", (req) =>
    guard(req, (p) =>
      authoring.edit(
        p,
        key(req.params.key),
        ver(req.params.v),
        withAuthor(p, parse(ReviseBody, req.body).proposal),
      ),
    ),
  );
  app.post<WKV>("/v1/workspaces/:id/metrics/:key/versions/:v/validate", (req) =>
    guard(req, (p) => authoring.validate(p, key(req.params.key), ver(req.params.v))),
  );
  app.post<WKV>("/v1/workspaces/:id/metrics/:key/versions/:v/certify", (req) =>
    guard(req, (p) => authoring.certify(p, key(req.params.key), ver(req.params.v))),
  );
  app.post<WKV>("/v1/workspaces/:id/metrics/:key/versions/:v/deprecate", (req) =>
    guard(req, (p) => {
      const b = parse(DeprecateBody, req.body);
      return authoring.deprecate(p, key(req.params.key), ver(req.params.v), b.reason, {
        correction: b.correction === true,
      });
    }),
  );
  app.post<WK>("/v1/workspaces/:id/metrics/:key/revisions", (req, reply) =>
    guard(req, async (p) => {
      const k = key(req.params.key);
      const b = parse(ReviseBody, req.body);
      const latest = (await authoring.versions(p, k)).versions.at(-1);
      const r = await authoring.revise(p, k, latest?.version ?? 1, withAuthor(p, b.proposal));
      return reply.status(201).send(r);
    }),
  );
  app.post<WKV>("/v1/workspaces/:id/metrics/:key/versions/:v/explore", (req) =>
    guard(req, (p) =>
      authoring.explore(
        p,
        { metricKey: key(req.params.key), version: ver(req.params.v) },
        rangeOf(parse(ExploreBody, req.body)),
      ),
    ),
  );
  app.post<WK>("/v1/workspaces/:id/metrics/:key/explore", (req) =>
    guard(req, (p) =>
      authoring.explore(p, { metricKey: key(req.params.key) }, rangeOf(parse(ExploreBody, req.body))),
    ),
  );
  app.post<W>("/v1/workspaces/:id/metrics/pins", (req) =>
    guard(req, async (p) => {
      const b = parse(PinBody, req.body);
      return { pins: await authoring.pinSnapshot(p, b.snapshotId, b.metrics) };
    }),
  );
  app.get<{ Params: { id: string; snapshotId: string } }>(
    "/v1/workspaces/:id/metrics/pins/:snapshotId",
    (req) => guard(req, async (p) => ({ pins: await authoring.pinsOf(p, req.params.snapshotId) })),
  );
  app.post<W>("/v1/workspaces/:id/metrics/publish-check", (req) =>
    guard(req, async (p) => {
      await authoring.assertPublishable(p, parse(PublishCheckBody, req.body).metrics);
      return { publishable: true };
    }),
  );
};
