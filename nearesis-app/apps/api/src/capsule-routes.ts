import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { KernelError, writeAudit } from "@nearesis/kernel";
import { guardCapsuleMetrics, principalOf } from "./metric-publish-guard.ts";
import type { PublishAuthoring } from "./metric-publish-guard.ts";
import type { Kernel, Session } from "@nearesis/kernel";
import { resolveCapsuleDir } from "./capsule-resolve.ts";
import { overlayProofs } from "./proof-view.ts";
import {
  anchorViewFor,
  defaultChainReadback,
  describePublications,
  loadAnchors,
  publishRoot,
} from "./publication-trust.ts";
import type { ChainReadback } from "./publication-trust.ts";
import {
  APP_ROOT,
  cautionStatuses,
  isCapsulePublic,
  loadCapsuleView,
  readCapsulePublicationState,
  writeCapsulePublicationState,
  readCapsuleOwnership,
  readManifest,
  verifyCapsule,
} from "@nearesis/capsule";

export interface CapsuleRoutesOptions {
  /** Governed metric authoring: a capsule using a non-CERTIFIED semantic metric cannot be published (422 METRIC_NOT_CERTIFIED). */
  authoring?: PublishAuthoring;
  kernel: Kernel;
  /** Test seam: reads a testnet commitment back from the chain (default: read-only NEAR RPC). */
  chainReadback?: ChainReadback;
}

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
export const capsuleRoutes: FastifyPluginAsync<CapsuleRoutesOptions> = async (
  app,
  { kernel, authoring, chainReadback },
) => {
  async function authenticate(req: FastifyRequest): Promise<Session> {
    const h = req.headers.authorization;
    const token = h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
    return kernel.identity.resolveSession(token);
  }
  // Capsule identity is the manifest `capsuleId`; the directory name is only a fallback (see capsule-resolve.ts).
  const dirOf = (id: string): string | null => resolveCapsuleDir(root(), id);
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
      ? { status: "available" as const, capsule: await overlayProofs(kernel, s, d, capsule) }
      : {
          status: "unavailable" as const,
          reason: "Capsule manifest failed validation; nothing is shown as verified.",
        };
  });

  /**
   * Explicit publication to the public MCP gateway (ch.12). Only members who can write (not viewers) may publish; the capsule
   * must be visible to the caller. The verification state comes from the verified-state gate (FND-072) and its badge is
   * recorded with the publication. A capsule carrying a cautionary status (INSUFFICIENT_DATA, METHOD_NOT_VALIDATED,
   * NOT_REPRODUCIBLE, a blocked attestation, or a failed local verification) is published only when the caller names every
   * such status in `acknowledge`. Publication and withdrawal are audited.
   */
  const AckBody = (b: unknown): string[] => {
    const a = (b as { acknowledge?: unknown } | null | undefined)?.acknowledge;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  };
  const audit = (
    s: Session,
    workspaceId: string,
    action: string,
    id: string,
    outcome: "ok" | "denied",
    reasonCode: string | null,
    detail: Record<string, unknown> = {},
  ) =>
    kernel.db.tx({ orgId: s.principal.orgId, userId: s.userId, actorKind: s.principal.kind }, (tx) =>
      writeAudit(tx, {
        orgId: s.principal.orgId,
        workspaceId,
        actorId: s.userId,
        action,
        subject: `capsule:${id}`,
        outcome,
        reasonCode,
        detail,
      }),
    );

  app.post<{ Params: { id: string }; Body: { acknowledge?: string[] } | undefined }>(
    "/v1/capsules/:id/publish",
    async (req) => {
      const s = await authenticate(req);
      const d = await visibleDir(s, req.params.id);
      const owner = d ? readCapsuleOwnership(d) : null;
      const m = d ? readManifest(d) : null;
      if (!d || !owner || !m) throw new KernelError("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");
      if (s.role === "viewer") {
        await audit(s, owner.workspaceId, "capsule.publish", req.params.id, "denied", "ROLE_CANNOT_PUBLISH");
        throw new KernelError("FORBIDDEN", "ROLE_CANNOT_PUBLISH", "Viewers cannot publish capsules.");
      }
      try {
        await guardCapsuleMetrics(
          authoring,
          principalOf(s, owner.workspaceId),
          m.metricVersions,
          `capsule:${req.params.id}`,
        );
      } catch (e) {
        if (e instanceof KernelError && e.reasonCode === "METRIC_NOT_CERTIFIED")
          await audit(
            s,
            owner.workspaceId,
            "capsule.publish",
            req.params.id,
            "denied",
            "METRIC_NOT_CERTIFIED",
            {
              detail: (e.opts.details ?? []).slice(0, 10),
            },
          );
        throw e;
      }
      const gate = await kernel.verifiedState.gate(s, owner.workspaceId, "capsule", req.params.id);
      const need = new Set(cautionStatuses(m));
      const rep = await verifyCapsule(d, { research: "skip", wasm: "skip" });
      if (rep.status !== "reproduced") need.add("VERIFICATION_FAILED");
      if (gate.state === "failed") need.add("VERIFIED_STATE_FAILED");
      const ack = new Set(AckBody(req.body));
      const missing = [...need].filter((x) => !ack.has(x)).sort();
      if (missing.length) {
        await audit(
          s,
          owner.workspaceId,
          "capsule.publish",
          req.params.id,
          "denied",
          "ACKNOWLEDGEMENT_REQUIRED",
          {
            missing,
          },
        );
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "ACKNOWLEDGEMENT_REQUIRED",
          `Publishing needs an explicit acknowledgement of: ${missing.join(", ")}.`,
          { details: missing.map((issue) => ({ path: "acknowledge", issue })) },
        );
      }
      writeCapsulePublicationState(d, {
        state: "published",
        orgId: owner.orgId,
        workspaceId: owner.workspaceId,
        actorId: s.userId,
        at: new Date().toISOString(),
        acknowledged: [...need].sort(),
        badge: gate.badge.label,
      });
      await audit(s, owner.workspaceId, "capsule.publish", req.params.id, "ok", null, {
        badge: gate.badge.label,
        acknowledged: [...need].sort(),
      });
      return { capsuleId: req.params.id, state: "published" as const, badge: gate.badge };
    },
  );

  app.post<{ Params: { id: string } }>("/v1/capsules/:id/unpublish", async (req) => {
    const s = await authenticate(req);
    const d = await visibleDir(s, req.params.id);
    const owner = d ? readCapsuleOwnership(d) : null;
    if (!d || !owner) throw new KernelError("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");
    if (s.role === "viewer") {
      await audit(s, owner.workspaceId, "capsule.unpublish", req.params.id, "denied", "ROLE_CANNOT_PUBLISH");
      throw new KernelError("FORBIDDEN", "ROLE_CANNOT_PUBLISH", "Viewers cannot unpublish capsules.");
    }
    const prev = readCapsulePublicationState(d);
    writeCapsulePublicationState(d, {
      state: "unpublished",
      orgId: owner.orgId,
      workspaceId: owner.workspaceId,
      actorId: s.userId,
      at: new Date().toISOString(),
      acknowledged: prev?.acknowledged ?? [],
      badge: prev?.badge ?? "unverified",
    });
    await audit(s, owner.workspaceId, "capsule.unpublish", req.params.id, "ok", null, {
      wasPublic: prev?.state === "published",
    });
    return { capsuleId: req.params.id, state: "unpublished" as const };
  });

  app.get<{ Params: { id: string } }>("/v1/capsules/:id/publication", async (req) => {
    const s = await authenticate(req);
    const d = await visibleDir(s, req.params.id);
    if (!d) throw new KernelError("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");
    return { capsuleId: req.params.id, public: isCapsulePublic(d), record: readCapsulePublicationState(d) };
  });

  /** Full local verification (re-runs the WASM under a local wasmtime when present). Labelled local, never OutLayer. */
  app.get<{ Params: { id: string } }>("/v1/capsules/:id/verify", async (req) => {
    const s = await authenticate(req);
    const d = await visibleDir(s, req.params.id);
    if (!d) throw new KernelError("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");
    const m = readManifest(d);
    const publications = m
      ? describePublications(join(publishRoot(), m.capsuleId), await loadAnchors(kernel))
      : [];
    return {
      scope: "local",
      ...(await verifyCapsule(d, { research: "skip", wasm: "crosscheck" })),
      // Signing key fingerprint, trusted-key status (registry incl. revocation) and anchors of every published version.
      publications,
      latestPublication: publications[0] ?? null,
    };
  });

  /**
   * Testnet commitment readback for a published capsule (latest version, or `?manifestHash=`): the recorded chain-commit
   * entry is read back from NEAR testnet at FINAL finality and compared with the manifest hash. Read-only; never sends a
   * transaction. `status`: verified | mismatch | not_committed | unavailable (RPC unreachable).
   */
  app.get<{ Params: { id: string }; Querystring: { manifestHash?: string } }>(
    "/v1/capsules/:id/anchor",
    async (req) => {
      const s = await authenticate(req);
      const d = await visibleDir(s, req.params.id);
      const m = d ? readManifest(d) : null;
      if (!d || !m) throw new KernelError("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");
      const anchors = await loadAnchors(kernel);
      const pubs = describePublications(join(publishRoot(), m.capsuleId), anchors);
      const want = req.query.manifestHash;
      if (want !== undefined && !/^[0-9a-f]{64}$/.test(want))
        throw new KernelError("VALIDATION_FAILED", "INVALID_QUERY", "manifestHash must be 64 lowercase hex.");
      // only a manifest of THIS capsule can be read back (no probing of other tenants' hashes)
      const rec = want ? pubs.find((p) => p.manifestHash === want) : pubs[0];
      if (!rec)
        throw new KernelError("NOT_FOUND", "PUBLICATION_NOT_FOUND", "No such publication of this capsule.");
      const view = anchorViewFor(anchors, rec.manifestHash);
      if (!view.chain)
        return {
          capsuleId: m.capsuleId,
          manifestHash: rec.manifestHash,
          status: "not_committed" as const,
          anchor: view,
          readback: null,
        };
      try {
        const rb = await (chainReadback ?? defaultChainReadback)(view.chain.txHash, rec.manifestHash);
        return {
          capsuleId: m.capsuleId,
          manifestHash: rec.manifestHash,
          status:
            rb.finality === "FINAL" && rb.succeeded && rb.equal
              ? ("verified" as const)
              : ("mismatch" as const),
          anchor: view,
          readback: {
            network: view.chain.network,
            contract: view.chain.contract,
            txHash: view.chain.txHash,
            finality: rb.finality,
            succeeded: rb.succeeded,
            receiver: rb.receiver,
            committedHash: rb.argsHash,
            viewPresent: rb.viewPresent,
            viewTimestampNs: String(rb.viewTimestampNs),
            equal: rb.equal,
          },
        };
      } catch (e) {
        return {
          capsuleId: m.capsuleId,
          manifestHash: rec.manifestHash,
          status: "unavailable" as const,
          anchor: view,
          readback: null,
          reason: `chain readback failed: ${(e as Error).message.slice(0, 200)}`,
        };
      }
    },
  );

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
