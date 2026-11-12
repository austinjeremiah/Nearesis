import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { KernelError } from "@nearesis/kernel";
import type { Session } from "@nearesis/kernel";
import { canonicalJson, loadLiveRegistry, sha256 } from "@nearesis/analytics";
import type { Registry } from "@nearesis/analytics";

export interface MetricRegistryRoutesOptions {
  authenticate(req: FastifyRequest): Promise<Session>;
  /** Default: the certified live registry, the same one `/v1/metrics` lists. Test seam. */
  registry?: () => Registry;
}

/**
 * Detail for REGISTRY (certified, non-authored) metrics, consistent with the `source: "registry"` rows of GET /v1/metrics.
 * Authored metrics are workspace-scoped and are read through /v1/workspaces/:id/metrics/*.
 *   GET /v1/metrics/:key            definition, certification, semantic hash, sources, evaluator, exact scale
 *   GET /v1/metrics/:key/versions   certified versions held by the registry (this build holds the current one only)
 * The registry is platform-wide (no tenant data), so a session is the only gate. An unknown key and an authored key are
 * the same 404 (an authored key is never revealed across tenants).
 */
export const metricRegistryRoutes: FastifyPluginAsync<MetricRegistryRoutesOptions> = async (app, opts) => {
  let cached: Registry | null = null;
  const reg = (): Registry => (cached ??= (opts.registry ?? loadLiveRegistry)());
  const find = (key: string) => {
    const r = reg();
    const m = r.metrics.find((x) => x.id === key);
    if (!m) throw new KernelError("NOT_FOUND", "METRIC_NOT_FOUND", "No registry metric has this key.");
    return { r, m };
  };
  const hashOf = (m: unknown) => sha256(canonicalJson(m));

  app.get<{ Params: { key: string } }>("/v1/metrics/:key", async (req) => {
    await opts.authenticate(req);
    const { r, m } = find(req.params.key);
    return {
      metricKey: m.id,
      source: "registry" as const,
      status: m.certified ? ("CERTIFIED" as const) : ("UNCERTIFIED" as const),
      version: m.certifiedVersion,
      displayName: m.displayName,
      unit: m.unit,
      exploratory: false,
      definition: {
        kind: m.kind,
        grain: m.grain,
        aggregationLaw: m.aggregationLaw,
        denominator: m.denominator,
        zeroPolicy: m.zeroPolicy,
        transformations: m.transformations,
        expectedUpdateLag: m.expectedUpdateLag,
        botProxyDefinition: m.botProxyDefinition,
        segmentOverlap: m.segmentOverlap,
        uncertainty: m.uncertainty,
        cubeMember: m.cubeMember,
        evaluator: r.evaluators[m.id] ?? null,
        exactScale: r.exactScales[m.id] ?? null,
      },
      sources: m.sources,
      visibility: m.visibility,
      owner: m.owner,
      docUri: m.docUri,
      certification: {
        certified: m.certified,
        certifiedVersion: m.certifiedVersion,
        registrySemanticVersion: r.semanticVersion,
      },
      semanticHash: hashOf(m),
      registryContentHash: r.contentHash,
    };
  });

  app.get<{ Params: { key: string } }>("/v1/metrics/:key/versions", async (req) => {
    await opts.authenticate(req);
    const { r, m } = find(req.params.key);
    return {
      metricKey: m.id,
      source: "registry" as const,
      versions: [
        {
          version: m.certifiedVersion,
          status: m.certified ? ("CERTIFIED" as const) : ("UNCERTIFIED" as const),
          current: true,
          semanticHash: hashOf(m),
          registrySemanticVersion: r.semanticVersion,
          registryContentHash: r.contentHash,
        },
      ],
      note: "The registry keeps one certified definition per metric; earlier registry versions are not retained by this build.",
    };
  });
};

(metricRegistryRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
