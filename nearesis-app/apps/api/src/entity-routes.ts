import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { KernelError, zodDetails } from "@nearesis/kernel";
import type { Session } from "@nearesis/kernel";
import {
  CANNOT_COMPUTE_UNIQUE_USERS,
  ClickHouseEntitySource,
  addDays,
  entityChanges,
  entityDaily,
  windowCoverage,
} from "@nearesis/analytics";
import type { EntityDataSource, RegistrySnapshot } from "@nearesis/analytics";
import { createClient } from "@clickhouse/client";

export interface EntityRoutesOptions {
  authenticate(req: FastifyRequest): Promise<Session>;
  /** Defaults to the live ClickHouse database (nearesis_live), created lazily on first request. */
  source?: EntityDataSource | undefined;
}

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "not a calendar date");
const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/);
const MAX_RANGE_DAYS = 400;
const ENTITY_TYPES = [
  "application",
  "protocol",
  "dao",
  "bridge",
  "token_contract",
  "intents_contract",
  "infrastructure",
  "category",
] as const;

const ListQ = z.strictObject({
  q: z.string().min(1).max(100).optional(),
  type: z.enum(ENTITY_TYPES).optional(),
  category: Id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const ChangesQ = z.strictObject({
  days: z.coerce.number().int().min(1).max(180).default(90),
  to: Day.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  type: z.enum(ENTITY_TYPES).optional(),
});
const RangeQ = z.strictObject({ from: Day, to: Day });
const CoverageQ = z.strictObject({
  from: Day.optional(),
  to: Day.optional(),
  days: z.coerce.number().int().min(1).max(MAX_RANGE_DAYS).default(90),
});

function parse<T extends z.ZodType>(schema: T, v: unknown): z.infer<T> {
  const r = schema.safeParse(v);
  if (!r.success)
    throw new KernelError("VALIDATION_FAILED", "INVALID_QUERY", "Invalid query parameters.", {
      details: zodDetails(r.error),
    });
  return r.data;
}
const notFound = (id: string) =>
  new KernelError("NOT_FOUND", "ENTITY_NOT_FOUND", `No entity ${id} in the registry.`);

/**
 * Versioned entity registry and entity metrics API (final_master_prompt s5). Contract for the frontend:
 *   GET /v1/entities?q&type&category&limit            -> { registryVersion, entities[] } search by name/id/description/account
 *   GET /v1/entities/registry                         -> { registryVersion, counts, verification breakdown, relations }
 *   GET /v1/entities/coverage?days|from&to            -> classified vs unclassified share + top unclassified/unverified receivers
 *   GET /v1/entities/changes?days=90&to&limit&type    -> ranked period-over-period change per entity, coverage, CANNOT_COMPUTE uniqueUsers
 *   GET /v1/entities/:id                              -> drilldown: entity, category, relations, mappings with evidence
 *   GET /v1/entities/:id/mappings                     -> mappings with source URL, effective interval, methodology, limitations
 *   GET /v1/entities/:id/metrics?from&to              -> daily interactions, share of total, coverage
 *   GET /v1/entities/:id/unique-users                 -> 200 { state: "CANNOT_COMPUTE", reasonCode, missingSource }
 * Errors: VALIDATION_FAILED (INVALID_QUERY), NOT_FOUND (ENTITY_NOT_FOUND), UPSTREAM_DEGRADED (ENTITY_SOURCE_UNAVAILABLE).
 * Registry data is global public reference data: no tenant rows are read or returned; every route still needs a session.
 */
export const entityRoutes: FastifyPluginAsync<EntityRoutesOptions> = async (app, opts) => {
  let source = opts.source;
  let client: ReturnType<typeof createClient> | undefined;
  const src = (): EntityDataSource => {
    if (!source) {
      client = createClient({
        url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
        username: process.env.NEARESIS_CH_USER ?? "nearesis",
        password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
        database: "nearesis_live",
      });
      source = new ClickHouseEntitySource(client);
    }
    return source;
  };
  app.addHook("onClose", async () => {
    await client?.close();
  });

  async function guarded<T>(req: FastifyRequest, fn: (s: EntityDataSource) => Promise<T>): Promise<T> {
    await opts.authenticate(req);
    try {
      return await fn(src());
    } catch (e) {
      if (e instanceof KernelError) throw e;
      req.log.error({ err: e }, "entity source failed");
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "ENTITY_SOURCE_UNAVAILABLE",
        "The entity data source is unavailable.",
        { retryable: true },
      );
    }
  }
  const loadReg = async (s: EntityDataSource): Promise<RegistrySnapshot> => {
    const r = await s.registry();
    if (r.registryVersion === "none")
      throw new KernelError("UPSTREAM_DEGRADED", "ENTITY_REGISTRY_EMPTY", "No entity registry is loaded.", {
        retryable: false,
      });
    return r;
  };
  const latest = async (s: EntityDataSource): Promise<string> => {
    const d = await s.latestDate();
    if (!d)
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "NO_ACTIVITY_DATA",
        "No contract interaction data is loaded.",
        { retryable: false },
      );
    return d;
  };

  app.get("/v1/entities", (req) =>
    guarded(req, async (s) => {
      const q = parse(ListQ, req.query);
      const reg = await loadReg(s);
      const needle = q.q?.toLowerCase();
      const byEntityAccounts = new Map<string, string[]>();
      for (const m of reg.mappings)
        byEntityAccounts.set(m.entityId, [...(byEntityAccounts.get(m.entityId) ?? []), m.account]);
      const entities = reg.entities
        .filter((e) => (q.type ? e.entityType === q.type : true))
        .filter((e) => (q.category ? e.categoryId === q.category : true))
        .filter((e) => {
          if (!needle) return true;
          return (
            e.entityId.includes(needle) ||
            e.name.toLowerCase().includes(needle) ||
            e.description.toLowerCase().includes(needle) ||
            (byEntityAccounts.get(e.entityId) ?? []).some((a) => a.toLowerCase().includes(needle))
          );
        })
        .slice(0, q.limit)
        .map((e) => ({ ...e, mappingCount: byEntityAccounts.get(e.entityId)?.length ?? 0 }));
      return { registryVersion: reg.registryVersion, entities };
    }),
  );

  app.get("/v1/entities/registry", (req) =>
    guarded(req, async (s) => {
      const reg = await loadReg(s);
      const verification = { verified: 0, inferred: 0, unverified: 0 };
      for (const m of reg.mappings) verification[m.verification]++;
      const types: Record<string, number> = {};
      for (const e of reg.entities) types[e.entityType] = (types[e.entityType] ?? 0) + 1;
      return {
        registryVersion: reg.registryVersion,
        counts: {
          entities: reg.entities.length,
          mappings: reg.mappings.length,
          relations: reg.relations.length,
        },
        entityTypes: types,
        mappingVerification: verification,
        relations: reg.relations,
        rules: [
          "Evidence URL required for every mapping; verified needs official docs, repo, explorer label or on-chain evidence.",
          "One (receiver, day) resolves to at most one entity: exact beats suffix, longer suffix beats shorter, then lower precedence; ties are ambiguous.",
          "Unverified mappings are never counted in a named entity.",
        ],
      };
    }),
  );

  app.get("/v1/entities/coverage", (req) =>
    guarded(req, async (s) => {
      const q = parse(CoverageQ, req.query);
      const reg = await loadReg(s);
      const to = q.to ?? (await latest(s));
      const from = q.from ?? addDays(to, -(q.days - 1));
      if (from > to || (Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS)
        throw new KernelError("VALIDATION_FAILED", "INVALID_RANGE", "Invalid date range.");
      const activity = await s.activity(from, to);
      return { registryVersion: reg.registryVersion, ...windowCoverage(reg, activity, from, to) };
    }),
  );

  app.get("/v1/entities/changes", (req) =>
    guarded(req, async (s) => {
      const q = parse(ChangesQ, req.query);
      const reg = await loadReg(s);
      const to = q.to ?? (await latest(s));
      const activity = await s.activity(addDays(to, -(2 * q.days - 1)), to);
      const rep = entityChanges(reg, activity, to, q.days);
      const types = new Map(reg.entities.map((e) => [e.entityId, e.entityType]));
      const entities = (
        q.type ? rep.entities.filter((e) => types.get(e.entityId) === q.type) : rep.entities
      ).slice(0, q.limit);
      return { ...rep, entities };
    }),
  );

  const entityOr404 = (reg: RegistrySnapshot, id: string) => {
    const e = reg.entities.find((x) => x.entityId === id);
    if (!e) throw notFound(id);
    return e;
  };

  app.get<{ Params: { id: string } }>("/v1/entities/:id", (req) =>
    guarded(req, async (s) => {
      const id = parse(Id, req.params.id);
      const reg = await loadReg(s);
      const entity = entityOr404(reg, id);
      return {
        registryVersion: reg.registryVersion,
        entity,
        category: reg.entities.find((e) => e.entityId === entity.categoryId) ?? null,
        parent: reg.entities.find((e) => e.entityId === entity.parentEntityId) ?? null,
        children: reg.entities.filter((e) => e.parentEntityId === id),
        relations: reg.relations.filter((r) => r.fromEntityId === id || r.toEntityId === id),
        mappings: reg.mappings.filter((m) => m.entityId === id),
        uniqueUsers: CANNOT_COMPUTE_UNIQUE_USERS,
      };
    }),
  );
  app.get<{ Params: { id: string } }>("/v1/entities/:id/mappings", (req) =>
    guarded(req, async (s) => {
      const id = parse(Id, req.params.id);
      const reg = await loadReg(s);
      entityOr404(reg, id);
      return {
        registryVersion: reg.registryVersion,
        entityId: id,
        mappings: reg.mappings.filter((m) => m.entityId === id),
      };
    }),
  );
  app.get<{ Params: { id: string } }>("/v1/entities/:id/metrics", (req) =>
    guarded(req, async (s) => {
      const id = parse(Id, req.params.id);
      const q = parse(RangeQ, req.query);
      if (q.from > q.to || (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 > MAX_RANGE_DAYS)
        throw new KernelError("VALIDATION_FAILED", "INVALID_RANGE", "Invalid date range.");
      const reg = await loadReg(s);
      entityOr404(reg, id);
      const activity = await s.activity(q.from, q.to);
      return {
        registryVersion: reg.registryVersion,
        entityId: id,
        metric: "contract_interactions",
        grain: "day",
        ...entityDaily(reg, activity, id, q.from, q.to),
        uniqueUsers: CANNOT_COMPUTE_UNIQUE_USERS,
      };
    }),
  );
  app.get<{ Params: { id: string } }>("/v1/entities/:id/unique-users", (req) =>
    guarded(req, async (s) => {
      const id = parse(Id, req.params.id);
      const reg = await loadReg(s);
      entityOr404(reg, id);
      return { entityId: id, ...CANNOT_COMPUTE_UNIQUE_USERS };
    }),
  );
};
