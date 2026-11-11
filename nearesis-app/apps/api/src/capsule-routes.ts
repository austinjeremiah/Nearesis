import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { KernelError } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import {
  APP_ROOT,
  loadCapsuleView,
  readCapsuleOwnership,
  readManifest,
  verifyCapsule,
} from "@nearesis/capsule";

export interface CapsuleRoutesOptions {
  kernel: Kernel;
}

const CAPSULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".json": "application/json; charset=utf-8",
};

/** Capsules live under NEARESIS_CAPSULE_DIR (default <app>/.data/capsules), one directory per capsule id. */
const root = (): string => process.env.NEARESIS_CAPSULE_DIR ?? join(APP_ROOT, ".data", "capsules");

/**
 * Read-only capsule API for the capsule viewer. Session required. `GET /v1/capsules/:id` returns the viewer's
 * `CapsuleResponse` shape: `{status:"available", capsule}` or `{status:"unavailable", reason}` (unknown and malformed ids
 * are indistinguishable). Verification here is local recomputation only: the record keeps `local` and `outlayer` apart and
 * never reports OutLayer "verified" without evidence that passed the proof policy and a quote verifier.
 */
export const capsuleRoutes: FastifyPluginAsync<CapsuleRoutesOptions> = async (app, { kernel }) => {
  async function authenticate(req: FastifyRequest): Promise<Session> {
    const h = req.headers.authorization;
    const token = h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
    return kernel.identity.resolveSession(token);
  }
  const dirOf = (id: string): string | null => {
    if (!CAPSULE_ID.test(id)) return null;
    const d = join(root(), id);
    return existsSync(join(d, "manifest.json")) ? d : null;
  };
  /**
   * Tenant gate. A capsule is visible only when its ownership record names the caller's org and a workspace the caller can
   * read (RLS-scoped lookup). Foreign, unowned, malformed and nonexistent ids all return null, so callers answer them
   * with one identical response.
   */
  const visibleDir = async (s: Session, id: string): Promise<string | null> => {
    const d = dirOf(id);
    if (!d) return null;
    const owner = readCapsuleOwnership(d);
    if (!owner || owner.orgId !== s.principal.orgId) return null;
    try {
      await kernel.workspaces.get(s, owner.workspaceId);
    } catch (e) {
      if (e instanceof KernelError) return null;
      throw e;
    }
    return d;
  };
  const unavailable = (id: string) => ({
    status: "unavailable" as const,
    reason: `Capsule ${id.slice(0, 60)} not found.`,
  });

  app.get("/v1/capsules", async (req) => {
    const s = await authenticate(req);
    const dir = root();
    const ids = existsSync(dir) ? readdirSync(dir).sort() : [];
    const capsules = [];
    for (const id of ids) {
      const d = await visibleDir(s, id);
      const m = d ? readManifest(d) : null;
      if (m)
        capsules.push({ capsuleId: m.capsuleId, title: m.title, label: m.label, createdAt: m.createdAt });
    }
    return { capsules };
  });

  app.get<{ Params: { id: string } }>("/v1/capsules/:id", async (req) => {
    const s = await authenticate(req);
    const d = await visibleDir(s, req.params.id);
    if (!d) return unavailable(req.params.id);
    const capsule = await loadCapsuleView(d, { research: "skip", wasm: "skip" });
    return capsule
      ? { status: "available" as const, capsule }
      : {
          status: "unavailable" as const,
          reason: "Capsule manifest failed validation; nothing is shown as verified.",
        };
  });

  /** Full local verification (re-runs the WASM under a local wasmtime when present). Labelled local, never OutLayer. */
  app.get<{ Params: { id: string } }>("/v1/capsules/:id/verify", async (req) => {
    const s = await authenticate(req);
    const d = await visibleDir(s, req.params.id);
    if (!d) throw new KernelError("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");
    return { scope: "local", ...(await verifyCapsule(d, { research: "skip", wasm: "crosscheck" })) };
  });

  /**
   * The capsule's recorded research run (research_run.json), served only when its bytes match the manifest hash. Scoped
   * exactly like the other capsule reads; a visible capsule built without a research run answers 404 RESEARCH_RUN_NOT_FOUND.
   */
  app.get<{ Params: { id: string } }>("/v1/capsules/:id/research-run", async (req, reply) => {
    const s = await authenticate(req);
    const d = await visibleDir(s, req.params.id);
    if (!d) throw new KernelError("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");
    const m = readManifest(d);
    if (!m?.research) throw new KernelError("NOT_FOUND", "RESEARCH_RUN_NOT_FOUND", "Research run not found.");
    const bytes = readFileSync(join(d, m.research.runFile.path));
    if (createHash("sha256").update(bytes).digest("hex") !== m.research.runFile.sha256)
      throw new KernelError(
        "DOMAIN_INVARIANT",
        "RESEARCH_RUN_HASH_MISMATCH",
        "Research run failed its hash check.",
      );
    void reply
      .header("content-type", "application/json; charset=utf-8")
      .header("x-content-type-options", "nosniff")
      .header("x-capsule-sha256", m.research.runFile.sha256)
      .header("x-research-method-version", m.research.methodVersion ?? "unknown")
      .header("x-research-method-revision", m.research.methodRevision ?? "unknown");
    return reply.send(bytes);
  });

  app.get<{ Params: { id: string; "*": string } }>("/v1/capsules/:id/exports/*", async (req, reply) => {
    const s = await authenticate(req);
    const d = await visibleDir(s, req.params.id);
    const m = d ? readManifest(d) : null;
    // Only files listed in the manifest are served; the lookup is by exact published path, never by a joined user path.
    const entry = m?.publication.files.find((f) => f.path === `exports/${req.params["*"]}`);
    if (!d || !entry) throw new KernelError("NOT_FOUND", "EXPORT_NOT_FOUND", "Export not found.");
    const bytes = readFileSync(join(d, entry.path));
    await kernel.integrity.verify(
      { orgId: s.principal.orgId, userId: s.userId },
      "capsule",
      `${req.params.id}/${entry.path}`,
      entry.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const ext = entry.path.slice(entry.path.lastIndexOf("."));
    void reply
      .header("content-type", TYPES[ext] ?? "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("x-capsule-sha256", entry.sha256)
      .header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      );
    return reply.send(bytes);
  });
};
