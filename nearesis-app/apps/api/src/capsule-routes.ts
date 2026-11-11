import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { KernelError } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import {
  APP_ROOT,
  loadCapsuleView,
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
  const unavailable = (id: string) => ({
    status: "unavailable" as const,
    reason: `Capsule ${id.slice(0, 60)} not found.`,
  });

  app.get("/v1/capsules", async (req) => {
    await authenticate(req);
    const dir = root();
    const ids = existsSync(dir)
      ? readdirSync(dir)
          .sort()
          .filter((n) => dirOf(n) !== null)
      : [];
    return {
      capsules: ids.flatMap((id) => {
        const m = readManifest(join(dir, id));
        return m ? [{ capsuleId: m.capsuleId, title: m.title, label: m.label, createdAt: m.createdAt }] : [];
      }),
    };
  });

  app.get<{ Params: { id: string } }>("/v1/capsules/:id", async (req) => {
    await authenticate(req);
    const d = dirOf(req.params.id);
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
    await authenticate(req);
    const d = dirOf(req.params.id);
    if (!d) throw new KernelError("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");
    return { scope: "local", ...(await verifyCapsule(d, { research: "skip", wasm: "crosscheck" })) };
  });

  app.get<{ Params: { id: string; "*": string } }>("/v1/capsules/:id/exports/*", async (req, reply) => {
    await authenticate(req);
    const d = dirOf(req.params.id);
    const m = d ? readManifest(d) : null;
    // Only files listed in the manifest are served; the lookup is by exact published path, never by a joined user path.
    const entry = m?.publication.files.find((f) => f.path === `exports/${req.params["*"]}`);
    if (!d || !entry) throw new KernelError("NOT_FOUND", "EXPORT_NOT_FOUND", "Export not found.");
    const ext = entry.path.slice(entry.path.lastIndexOf("."));
    void reply
      .header("content-type", TYPES[ext] ?? "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("x-capsule-sha256", entry.sha256)
      .header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      );
    return reply.send(readFileSync(join(d, entry.path)));
  });
};
