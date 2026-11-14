import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { KernelError } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import { APP_ROOT } from "@nearesis/capsule";

export interface ThesisTrackOptions {
  kernel: Kernel;
}

/** Thesis track bundle directory (thesis/ under the app root); NEARESIS_THESIS_DIR overrides it for tests. */
const thesisDir = (): string => process.env.NEARESIS_THESIS_DIR ?? join(APP_ROOT, "thesis");

const TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
};

/** Served paths relative to thesis/: build outputs, raw frozen data, SQL and TABLES.md. Nothing else. */
const ALLOW = [
  /^build\/(THESIS\.md|thesis\.json|HASHES\.json|site\/index\.html)$/,
  /^raw\/[A-Za-z0-9_.-]+\.json$/,
  /^sql\/(executed|bigquery)\/[A-Za-z0-9_.-]+\.sql$/,
  /^TABLES\.md$/,
];

const notFound = (): KernelError =>
  new KernelError("NOT_FOUND", "THESIS_FILE_NOT_FOUND", "Thesis file not found.");

export const thesisTrackRoutes: FastifyPluginAsync<ThesisTrackOptions> = async (app, { kernel }) => {
  async function authenticate(req: FastifyRequest): Promise<Session> {
    const h = req.headers.authorization;
    const token = h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
    return kernel.identity.resolveSession(token);
  }

  /** The built thesis.json, byte for byte. */
  app.get("/v1/thesis", async (req, reply) => {
    await authenticate(req);
    const p = join(thesisDir(), "build", "thesis.json");
    if (!existsSync(p))
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "THESIS_NOT_BUILT",
        "The thesis bundle has not been built; run pnpm thesis:build.",
      );
    void reply
      .header("content-type", TYPES[".json"])
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-cache");
    return reply.send(readFileSync(p));
  });

  app.get<{ Params: { "*": string } }>("/v1/thesis/files/*", async (req, reply) => {
    await authenticate(req);
    const rel = req.params["*"];
    if (!ALLOW.some((r) => r.test(rel))) throw notFound();
    const base = resolve(thesisDir());
    const full = resolve(base, rel);
    if (!full.startsWith(base + sep) || !existsSync(full) || !statSync(full).isFile()) throw notFound();
    // A symlink must not lead out of thesis/.
    if (!realpathSync(full).startsWith(realpathSync(base) + sep)) throw notFound();
    const ext = extname(full);
    void reply
      .header("content-type", TYPES[ext] ?? "application/octet-stream")
      .header("x-content-type-options", "nosniff");
    if (ext === ".html")
      void reply.header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; sandbox allow-scripts",
      );
    return reply.send(readFileSync(full));
  });
};
