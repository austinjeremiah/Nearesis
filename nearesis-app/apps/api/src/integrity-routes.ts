import type { FastifyPluginAsync } from "fastify";
import type { Kernel } from "@nearesis/kernel";

/**
 * Visible integrity state: the artefacts quarantined after a failed hash check (own tenant plus platform-level ones).
 * A panel or claim that depends on a listed artefact is not shown as verified or current.
 */
export const integrityRoutes: FastifyPluginAsync<{ kernel: Kernel }> = async (app, { kernel }) => {
  app.get("/v1/integrity/quarantine", async (req) => {
    const h = req.headers.authorization;
    const token = h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
    const s = await kernel.identity.resolveSession(token);
    return { records: await kernel.integrity.list({ orgId: s.principal.orgId, userId: s.userId }) };
  });
};
