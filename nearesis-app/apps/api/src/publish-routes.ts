import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  KernelError,
  chargeUsdIn,
  holdUsdIn,
  releaseUsdIn,
  writeAudit,
  yoctoToMicroUsd,
} from "@nearesis/kernel";
import type { NearUsdRate, NearUsdRateReader } from "./near-usd-rate.ts";
import { usdCreditsOf } from "./usd-credits-api.ts";
import { guardCapsuleMetrics, principalOf } from "./metric-publish-guard.ts";
import type { PublishAuthoring } from "./metric-publish-guard.ts";
import type { Kernel, Session } from "@nearesis/kernel";
import { resolvePublishSigner } from "./publish-signer.ts";
import { resolveCapsuleDir } from "./capsule-resolve.ts";
import { anchorViewFor, describePublications, dropAnchorCache, loadAnchors } from "./publication-trust.ts";
import type { ChainCommitPayload } from "@nearesis/capsule";
import {
  APP_ROOT,
  appendChainCommitAnchor,
  appendPublishAnchor,
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
  /**
   * Commits a published manifest hash on-chain (NEAR testnet, hash only, approved path). Optional; when absent the response
   * reports `anchor.chain: "not_configured"`. A failure never fails the publication: the log entry already exists.
   */
  anchorChain?: (manifestHash: string) => Promise<ChainCommitPayload & { spentYocto?: string }>;
  /**
   * Credits held from the caller before the testnet anchor is sent (default 0.005 testnet NEAR, the anchor's own budget). The
   * gas actually burnt (`spentYocto` of the anchor result) is charged afterwards and the rest released. Nothing is held when
   * `anchorChain` is not configured.
   */
  anchorHoldYocto?: bigint;
  /** NEAR -> USD (latest local daily close). Absent: an anchored publication answers 503 PRICE_UNAVAILABLE. */
  nearUsdRate?: NearUsdRateReader;
}

/** The anchor's own spending limit (scripts/release/testnet-anchor-manifest.ts ANCHOR_BUDGET_YOCTO): 0.005 NEAR. */
export const DEFAULT_ANCHOR_HOLD_YOCTO = 5n * 10n ** 21n;

const CAPSULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const capsuleRoot = (): string => process.env.NEARESIS_CAPSULE_DIR ?? join(APP_ROOT, ".data", "capsules");
const publishRoot = (): string => process.env.NEARESIS_PUBLISH_DIR ?? join(APP_ROOT, ".data", "published");

/**
 * `POST /v1/publish` (ch.11: approved immutable claim set -> scheduled export workflow). Builds the static publication
 * bundle for a capsule the caller can see and writes its signed publish manifest beside it (`publishStatic`), verifies it
 * offline, then records `research.published` in the workspace journal and a `publication.ready.v1` outbox row in the SAME
 * transaction. Only members who can write may publish; a capsule carrying a cautionary status (INSUFFICIENT_DATA, ...) needs
 * the same explicit acknowledgement as the MCP publication route. This route never changes public MCP visibility
 * (`/v1/capsules/:id/publish` owns that).
 */
export const publishRoutes: FastifyPluginAsync<PublishRoutesOptions> = async (
  app,
  { kernel, authoring, anchorChain, anchorHoldYocto, nearUsdRate },
) => {
  const holdAmount = anchorHoldYocto ?? DEFAULT_ANCHOR_HOLD_YOCTO;
  const usdCredits = usdCreditsOf(kernel.db);
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

  type PublishReq = FastifyRequest<{ Body: { capsuleId?: string; acknowledge?: string[] } | undefined }>;
  /** Credits held for the anchor of this request (0n = nothing held). Settled or released exactly once. */
  interface AnchorHold {
    /** Held micro-USD. */
    amount: bigint;
    rate: NearUsdRate | null;
    userId: string;
    orgId: string;
  }
  const publishOnce = async (req: PublishReq, reply: FastifyReply, hold: AnchorHold) => {
    const s = await authenticate(req);
    const id = req.body?.capsuleId;
    const notFound = new KernelError("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");
    if (typeof id !== "string" || !CAPSULE_ID.test(id)) throw notFound;
    const dir = resolveCapsuleDir(capsuleRoot(), id) ?? join(capsuleRoot(), id);
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

    // Workspace-run capsules have no research memo or executed-query lineage: the static bundle is for research capsules.
    try {
      const kind = (
        JSON.parse(readFileSync(join(dir, "snapshot", "snapshot.json"), "utf8")) as { kind?: string }
      ).kind;
      if (kind === "workspace_run")
        throw new KernelError(
          "VALIDATION_FAILED",
          "PUBLICATION_NOT_SUPPORTED",
          "A workspace-run capsule has no static publication bundle; it is published through POST /v1/capsules/:id/publish.",
        );
    } catch (e) {
      if (e instanceof KernelError) throw e;
    }

    // Anchor gas is paid by the caller's credits: hold an estimate before anything is sent, so a caller without credits
    // is refused (402) before the publication is recorded.
    if (anchorChain) {
      let rate: NearUsdRate | null = null;
      try {
        rate = (await nearUsdRate?.()) ?? null;
      } catch {
        rate = null;
      }
      if (!rate)
        throw new KernelError(
          "UPSTREAM_DEGRADED",
          "PRICE_UNAVAILABLE",
          "No NEAR/USD price is available, so the anchor gas cannot be priced in credits.",
          { retryable: true },
        );
      const holdMicro = yoctoToMicroUsd(holdAmount, rate.rate);
      await usdCredits.reconcileRuns(s.userId).catch(() => undefined);
      await kernel.db.tx({ orgId: s.principal.orgId, userId: s.userId, actorKind: s.principal.kind }, (tx) =>
        holdUsdIn(tx, s.userId, usdCredits.allowanceMicro, holdMicro, {
          refKind: "publication",
          refId: id,
          category: "anchor",
          detail: {
            capsuleId: id,
            kind: "publication_anchor_hold",
            holdYocto: holdAmount.toString(),
            nearUsdRate: rate.rate,
            rateDate: rate.date,
          },
        }),
      );
      hold.amount = holdMicro;
      hold.rate = rate;
      hold.userId = s.userId;
      hold.orgId = s.principal.orgId;
    }

    let published: ReturnType<typeof publishStatic>;
    let signing: { source: string; hardened: boolean } = { source: "none", hardened: false };
    try {
      const resolved = resolvePublishSigner();
      if (resolved.kind === "refused") {
        app.log.error({ hardened: false, signingSource: resolved.source }, resolved.reason);
        throw new KernelError("UPSTREAM_DEGRADED", "PLAINTEXT_PUBLISH_KEY_REFUSED", resolved.reason);
      }
      signing = { source: resolved.source, hardened: resolved.hardened };
      if (resolved.kind === "signer" && !resolved.hardened)
        app.log.warn(
          { hardened: false, signingSource: resolved.source },
          "publishing with a plaintext key (dev only)",
        );
      const pem = resolved.kind === "signer" ? resolved.privateKeyPem : null;
      published = publishStatic({
        snapshotDir: join(dir, "snapshot"),
        capsuleId: manifest.capsuleId,
        ...(manifest.research ? { researchBundleDir: join(dir, "research") } : {}),
        ...(manifest.metricVersions ? { metricVersions: manifest.metricVersions } : {}),
        root: join(publishRoot(), manifest.capsuleId),
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
    let anchor: Record<string, unknown> = { log: "none", chain: "not_configured" };
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
          detail: { version: data.version, manifestHash: data.manifestHash, hardened: signing.hardened },
        });
        // independent append-only record (database clock): first publication of this manifest hash only
        const seen = await tx.query(
          "SELECT 1 FROM publication_anchor_log WHERE manifest_hash = $1 AND kind = 'publish'",
          [data.manifestHash],
        );
        if (seen.rows.length === 0) {
          const sig = published.manifest.signature;
          const a = await appendPublishAnchor(tx, {
            manifestHash: data.manifestHash,
            signedAt: sig.alg === "ed25519" ? (sig.signedAt ?? null) : null,
            capsuleId: id,
            version: data.version,
            keyFingerprint: sig.alg === "ed25519" ? sig.keyId : null,
          });
          anchor = { log: "appended", seq: a.seq, anchoredAt: a.anchoredAt, chain: "not_configured" };
        } else anchor = { log: "already_recorded", chain: "not_configured" };
        return e;
      },
    );
    let burnt: bigint | null = null;
    let anchorTx: string | null = null;
    if (anchor.log === "appended" && anchorChain) {
      try {
        const c = await anchorChain(data.manifestHash);
        anchorTx = c.txHash;
        burnt = c.spentYocto !== undefined && /^\d+$/.test(c.spentYocto) ? BigInt(c.spentYocto) : null;
        await kernel.db.tx(
          { orgId: s.principal.orgId, userId: s.userId, actorKind: s.principal.kind },
          (tx) => appendChainCommitAnchor(tx, { manifestHash: data.manifestHash, ...c }),
        );
        anchor = { ...anchor, chain: "committed", network: c.network, txHash: c.txHash };
      } catch (e) {
        app.log.error({ err: (e as Error).message }, "publication chain anchor failed");
        anchor = { ...anchor, chain: "failed" };
      }
    }
    await settleHold(hold, id, data.manifestHash, burnt, anchorTx);
    dropAnchorCache();
    const entries = await loadAnchors(kernel);
    const view = anchorViewFor(entries, data.manifestHash);
    const record = describePublications(join(publishRoot(), manifest.capsuleId), entries).find(
      (r) => r.manifestHash === data.manifestHash,
    );
    return {
      ...data,
      signingSource: signing.source,
      hardened: signing.hardened,
      // Key fingerprint (sha256 of SPKI DER), trusted-key registry status incl. revocation, and why.
      signingKey: record?.key ?? null,
      anchor: {
        ...anchor,
        entryHash: view.log?.entryHash ?? null,
        anchoredAt: view.log?.anchoredAt ?? (anchor.anchoredAt as string | undefined) ?? null,
        testnet: view.chain
          ? { ...view.chain, readback: "verified_at_commit" as const }
          : { status: anchor.chain as string },
      },
      created: published.bundle.created,
      eventId: ev.eventId,
      seq: ev.seq,
      topics: ["research.published", "publication.ready.v1"],
      manifestFile: `${published.bundle.version}.publish-manifest.json`,
    };
  };

  /** Charges the gas actually burnt from the hold and releases the rest (all of it when no anchor was sent or its cost is unknown). */
  async function settleHold(
    hold: AnchorHold,
    capsuleId: string,
    manifestHash: string,
    burnt: bigint | null,
    txHash: string | null,
  ): Promise<void> {
    if (hold.amount === 0n) return;
    const amount = hold.amount;
    hold.amount = 0n;
    const ctx = { orgId: hold.orgId, userId: hold.userId };
    const rate = hold.rate;
    const ref = {
      refKind: "publication",
      refId: manifestHash,
      category: "anchor" as const,
      detail: {
        capsuleId,
        kind: "publication_anchor",
        ...(txHash ? { txHash } : {}),
        ...(burnt !== null ? { gasBurntYocto: burnt.toString() } : {}),
        ...(rate ? { nearUsdRate: rate.rate, rateDate: rate.date } : {}),
      },
    };
    await kernel.db.tx(ctx, async (tx) => {
      if (burnt !== null && txHash && rate)
        await chargeUsdIn(
          tx,
          hold.userId,
          usdCredits.allowanceMicro,
          amount,
          yoctoToMicroUsd(burnt, rate.rate),
          ref,
        );
      else await releaseUsdIn(tx, hold.userId, usdCredits.allowanceMicro, amount, ref);
    });
  }

  app.post<{ Body: { capsuleId?: string; acknowledge?: string[] } | undefined }>(
    "/v1/publish",
    async (req, reply) => {
      const hold: AnchorHold = { amount: 0n, rate: null, userId: "", orgId: "" };
      try {
        return await publishOnce(req, reply, hold);
      } catch (e) {
        // any failure after the hold: nothing was anchored for the caller's account, give the whole hold back
        if (hold.amount > 0n)
          await settleHold(hold, req.body?.capsuleId ?? "", req.body?.capsuleId ?? "", null, null).catch(
            () => undefined,
          );
        throw e;
      }
    },
  );
};
