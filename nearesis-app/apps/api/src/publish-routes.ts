import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { KernelError, writeAudit } from "@nearesis/kernel";
import { guardCapsuleMetrics, principalOf } from "./metric-publish-guard.ts";
import type { PublishAuthoring } from "./metric-publish-guard.ts";
import type { Kernel, Session } from "@nearesis/kernel";
import {
  APP_ROOT,
  PublicationBlockedError,
  PublishBlockedError,
  SnapshotError,
  cautionStatuses,
  publishStatic,
  readCapsuleOwnership,
  readManifest,
  verifyPublishManifest,
} from "@nearesis/capsule";

export interface PublishRoutesOptions {
  kernel: Kernel;
  /** Governed metric authoring: when set, a capsule using a non-CERTIFIED semantic metric cannot be published (422 METRIC_NOT_CERTIFIED). */
  authoring?: PublishAuthoring;
}

const CAPSULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const capsuleRoot = (): string => process.env.NEARESIS_CAPSULE_DIR ?? join(APP_ROOT, ".data", "capsules");
const publishRoot = (): string => process.env.NEARESIS_PUBLISH_DIR ?? join(APP_ROOT, ".data", "published");
/** Optional ed25519 PKCS8 PEM file for the publish manifest signature; absent means an honestly `unsigned` manifest. */
const signerPem = (): string | null => {
  const f = process.env.NEARESIS_PUBLISH_KEY_FILE;
  return f && existsSync(f) ? readFileSync(f, "utf8") : null;
};

/**
 * `POST /v1/publish` (ch.11: approved immutable claim set -> scheduled export workflow). Builds the static publication
 * bundle for a capsule the caller can see and writes its signed publish manifest beside it (`publishStatic`), verifies it
 * offline, then records `research.published` in the workspace journal and a `publication.ready.v1` outbox row in the SAME
 * transaction. Only members who can write may publish; a capsule carrying a cautionary status (INSUFFICIENT_DATA, ...) needs
 * the same explicit acknowledgement as the MCP publication route. This route never changes public MCP visibility
 * (`/v1/capsules/:id/publish` owns that).
 */
export const publishRoutes: FastifyPluginAsync<PublishRoutesOptions> = async (app, { kernel, authoring }) => {
  async function authenticate(req: FastifyRequest): Promise<Session> {
    const h = req.headers.authorization;
    const token = h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
    return kernel.identity.resolveSession(token);
  }
  const audit = (
    s: Session,
    workspaceId: string,
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
        action: "publication.export",
        subject: `capsule:${id}`,
        outcome,
        reasonCode,
        detail,
      }),
    );

  app.post<{ Body: { capsuleId?: string; acknowledge?: string[] } | undefined }>(
    "/v1/publish",
    async (req) => {
      const s = await authenticate(req);
      const id = req.body?.capsuleId;
      const notFound = new KernelError("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");
      if (typeof id !== "string" || !CAPSULE_ID.test(id)) throw notFound;
      const dir = join(capsuleRoot(), id);
      const owner = existsSync(join(dir, "manifest.json")) ? readCapsuleOwnership(dir) : null;
      const manifest = owner ? readManifest(dir) : null;
      if (!owner || !manifest || owner.orgId !== s.principal.orgId) throw notFound;
      try {
        await kernel.workspaces.get(s, owner.workspaceId);
      } catch (e) {
        if (e instanceof KernelError) throw notFound;
        throw e;
      }
      if (s.role === "viewer") {
        await audit(s, owner.workspaceId, id, "denied", "ROLE_CANNOT_PUBLISH");
        throw new KernelError("FORBIDDEN", "ROLE_CANNOT_PUBLISH", "Viewers cannot publish.");
      }
      const ack = new Set(Array.isArray(req.body?.acknowledge) ? req.body!.acknowledge : []);
      const missing = cautionStatuses(manifest)
        .filter((x) => !ack.has(x))
        .sort();
      if (missing.length) {
        await audit(s, owner.workspaceId, id, "denied", "ACKNOWLEDGEMENT_REQUIRED", { missing });
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "ACKNOWLEDGEMENT_REQUIRED",
          `Publishing needs an explicit acknowledgement of: ${missing.join(", ")}.`,
          { details: missing.map((issue) => ({ path: "acknowledge", issue })) },
        );
      }

      try {
        await guardCapsuleMetrics(
          authoring,
          principalOf(s, owner.workspaceId),
          manifest.metricVersions,
          `capsule:${id}`,
        );
      } catch (e) {
        if (e instanceof KernelError && e.reasonCode === "METRIC_NOT_CERTIFIED")
          await audit(s, owner.workspaceId, id, "denied", "METRIC_NOT_CERTIFIED", {
            detail: (e.opts.details ?? []).slice(0, 10),
          });
        throw e;
      }

      let published: ReturnType<typeof publishStatic>;
      try {
        const pem = signerPem();
        published = publishStatic({
          snapshotDir: join(dir, "snapshot"),
          capsuleId: manifest.capsuleId,
          ...(manifest.research ? { researchBundleDir: join(dir, "research") } : {}),
          ...(manifest.metricVersions ? { metricVersions: manifest.metricVersions } : {}),
          root: join(publishRoot(), id),
          ...(pem ? { signer: { privateKeyPem: pem } } : {}),
        });
      } catch (e) {
        const detail =
          e instanceof PublishBlockedError
            ? e.problems
            : e instanceof PublicationBlockedError
              ? e.violations.slice(0, 10).map((v) => `${e.file}: ${v.kind} ${v.number}`)
              : e instanceof SnapshotError
                ? [e.message]
                : null;
        if (!detail) throw e;
        await audit(s, owner.workspaceId, id, "denied", "PUBLICATION_BLOCKED", {
          detail: detail.slice(0, 10),
        });
        throw new KernelError("DOMAIN_INVARIANT", "PUBLICATION_BLOCKED", "Publication blocked.", {
          details: detail.map((issue) => ({ path: "bundle", issue })),
        });
      }
      if (published.bundle.capsuleHash !== manifest.capsuleHash) {
        await audit(s, owner.workspaceId, id, "denied", "CAPSULE_NOT_REPRODUCIBLE_FROM_SNAPSHOT");
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "CAPSULE_NOT_REPRODUCIBLE_FROM_SNAPSHOT",
          "The capsule does not rebuild to its recorded hash from its own snapshot; nothing is exported.",
        );
      }
      const v = verifyPublishManifest(published.bundle.dir, published.manifestPath);
      if (!v.ok) {
        await audit(s, owner.workspaceId, id, "denied", "PUBLISH_MANIFEST_INVALID", {
          problems: v.problems.slice(0, 10),
        });
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "PUBLISH_MANIFEST_INVALID",
          "Publish manifest failed verification.",
        );
      }
      const data = {
        capsuleId: id,
        version: published.bundle.version,
        capsuleHash: published.bundle.capsuleHash,
        manifestHash: published.manifest.manifestHash,
        bundleHash: published.manifest.bundle.bundleHash,
        label: manifest.label,
        signature: v.signature,
      };
      const ev = await kernel.db.tx(
        { orgId: s.principal.orgId, userId: s.userId, actorKind: s.principal.kind },
        async (tx) => {
          // the journal assigns seq under the workspace row lock
          await tx.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [owner.workspaceId]);
          const e = await kernel.journal.append(tx, {
            orgId: s.principal.orgId,
            workspaceId: owner.workspaceId,
            type: "research.published",
            actorId: s.userId,
            data,
          });
          await tx.query(
            "INSERT INTO outbox(id, event_id, org_id, workspace_id, topic) VALUES (gen_random_uuid(), $1, $2, $3, $4)",
            [e.eventId, s.principal.orgId, owner.workspaceId, "publication.ready.v1"],
          );
          await writeAudit(tx, {
            orgId: s.principal.orgId,
            workspaceId: owner.workspaceId,
            actorId: s.userId,
            action: "publication.export",
            subject: `capsule:${id}`,
            outcome: "ok",
            reasonCode: null,
            detail: { version: data.version, manifestHash: data.manifestHash },
          });
          return e;
        },
      );
      return {
        ...data,
        created: published.bundle.created,
        eventId: ev.eventId,
        seq: ev.seq,
        topics: ["research.published", "publication.ready.v1"],
        manifestFile: `${published.bundle.version}.publish-manifest.json`,
      };
    },
  );
};
