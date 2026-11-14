import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { KernelError } from "@nearesis/kernel";
import type { Kernel } from "@nearesis/kernel";
import {
  APP_ROOT,
  isCapsulePublic,
  loadCapsuleView,
  readCapsulePublicationState,
  readManifest,
} from "@nearesis/capsule";
import { resolveCapsuleDir } from "./capsule-resolve.ts";
import { describePublications, loadAnchors, publishRoot } from "./publication-trust.ts";

export interface PublicPublicationRoutesOptions {
  kernel: Kernel;
  /** Requests per window per client IP (default 60 per minute). */
  perWindow?: number;
  windowMs?: number;
  now?: () => number;
}

const root = (): string => process.env.NEARESIS_CAPSULE_DIR ?? join(APP_ROOT, ".data", "capsules");
const TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".json": "application/json; charset=utf-8",
};

/**
 * Unauthenticated, read-only public view of EXPLICITLY published capsules (the same gate as the public MCP gateway:
 * `isCapsulePublic`). No session, no cookies, GET only, fixed-window rate limit per IP.
 *   GET /v1/public/publications/:id             manifest summary, bundle hashes, verification labels, signing-key trust, anchors, docs
 *   GET /v1/public/publications/:id/exports/*   a published document (only files listed in the manifest, hash-checked)
 * Never exposed: org or workspace ids, the actor, unpublished or never-published capsules. A withdrawn publication answers
 * 404 PUBLICATION_WITHDRAWN (the error taxonomy has no 410); unknown, malformed, never-published and not-published ids answer one identical 404.
 */
export const publicPublicationRoutes: FastifyPluginAsync<PublicPublicationRoutesOptions> = async (
  app,
  opts,
) => {
  const limit = opts.perWindow ?? 60;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { start: number; n: number }>();
  const take = (ip: string): number | null => {
    const t = now();
    if (buckets.size > 10_000) for (const [k, b] of buckets) if (t - b.start >= windowMs) buckets.delete(k);
    let b = buckets.get(ip);
    if (!b || t - b.start >= windowMs) {
      b = { start: t, n: 0 };
      buckets.set(ip, b);
    }
    b.n++;
    return b.n <= limit ? null : Math.max(1, Math.ceil((b.start + windowMs - t) / 1000));
  };
  const notFound = () => new KernelError("NOT_FOUND", "PUBLICATION_NOT_FOUND", "Publication not found.");

  const gate = (
    req: { ip: string },
    reply: { header(k: string, v: string): unknown },
    id: string,
  ): string => {
    const wait = take(req.ip);
    if (wait !== null) {
      void reply.header("retry-after", String(wait));
      throw new KernelError("RATE_LIMITED", "TOO_MANY_REQUESTS", "Too many requests.", { retryable: true });
    }
    const d = resolveCapsuleDir(root(), id);
    if (!d) throw notFound();
    if (!isCapsulePublic(d)) {
      if (readCapsulePublicationState(d)?.state === "unpublished")
        throw new KernelError("NOT_FOUND", "PUBLICATION_WITHDRAWN", "This publication was withdrawn.");
      throw notFound();
    }
    return d;
  };

  app.get<{ Params: { id: string } }>("/v1/public/publications/:id", async (req, reply) => {
    const d = gate(req, reply, req.params.id);
    const m = readManifest(d);
    const rec = readCapsulePublicationState(d);
    if (!m || !rec) throw notFound();
    const view = await loadCapsuleView(d, { research: "skip", wasm: "skip" });
    const versions = describePublications(join(publishRoot(), m.capsuleId), await loadAnchors(opts.kernel));
    void reply.header("cache-control", "public, max-age=60").header("x-content-type-options", "nosniff");
    return {
      capsuleId: m.capsuleId,
      title: m.title,
      label: m.label,
      createdAt: m.createdAt,
      state: "published" as const,
      publishedAt: rec.at,
      badge: rec.badge,
      acknowledgedCautions: rec.acknowledged,
      hashes: m.hashes,
      verification: view ? view.verification : null,
      claims: view?.claims ?? [],
      results: view?.results ?? [],
      documents: m.publication.files.map((f) => ({
        path: f.path,
        sha256: f.sha256,
        url: `/v1/public/publications/${encodeURIComponent(m.capsuleId)}/${f.path}`,
      })),
      versions: versions.map((v) => ({
        version: v.version,
        manifestHash: v.manifestHash,
        bundleHash: v.bundleHash,
        capsuleHash: v.capsuleHash,
        signature: v.signature,
        key: v.key,
        verification: v.verification,
        anchor: v.anchor,
      })),
    };
  });

  app.get<{ Params: { id: string; "*": string } }>(
    "/v1/public/publications/:id/exports/*",
    async (req, reply) => {
      const d = gate(req, reply, req.params.id);
      const m = readManifest(d);
      const entry = m?.publication.files.find((f) => f.path === `exports/${req.params["*"]}`);
      if (!m || !entry) throw new KernelError("NOT_FOUND", "EXPORT_NOT_FOUND", "Export not found.");
      const bytes = readFileSync(join(d, entry.path));
      if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
        throw new KernelError("INTERNAL", "EXPORT_HASH_MISMATCH", "Export failed its hash check.");
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
    },
  );
};

(publicPublicationRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
