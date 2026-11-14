import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  fingerprintOf,
  readAnchorLog,
  readRegistry,
  registryPathFromEnv,
  verifyPublishManifest,
} from "@nearesis/capsule";
import type { AnchorEntry, ChainCommitPayload, PublishManifest } from "@nearesis/capsule";
import type { Kernel } from "@nearesis/kernel";
import { APP_ROOT } from "@nearesis/capsule";

export const publishRoot = (): string =>
  process.env.NEARESIS_PUBLISH_DIR ?? join(APP_ROOT, ".data", "published");

/** Reads the testnet commitment back from the chain (read-only RPC). Injectable for tests. */
export type ChainReadback = (
  txHash: string,
  manifestHash: string,
) => Promise<{
  finality: string;
  succeeded: boolean;
  receiver: string;
  argsHash: string | null;
  viewPresent: boolean;
  viewTimestampNs: string | number | bigint | null;
  equal: boolean;
}>;

export const defaultChainReadback: ChainReadback = async (txHash, manifestHash) =>
  (await import("../../../plugins/chain-commit/src/live.ts")).readbackLive(txHash, manifestHash);

export interface KeyTrust {
  fingerprint: string | null;
  keyId: string | null;
  /** From the trusted-publish-keys registry: active, revoked or unknown (not in the registry). */
  keyStatus: "active" | "revoked" | "unknown" | "unsigned";
  revokedAt: string | null;
  trusted: boolean;
  trustReason: string;
}
export interface AnchorView {
  log: { seq: number; anchoredAt: string; entryHash: string; prevHash: string } | null;
  chain: {
    network: string;
    contract: string;
    txHash: string;
    viewTimestampNs: string;
    logSeq: number;
  } | null;
}
export interface PublicationRecord {
  version: string;
  manifestHash: string;
  bundleHash: string;
  capsuleHash: string;
  signature: { alg: "ed25519" | "none"; signedAt: string | null };
  key: KeyTrust;
  verification: { ok: boolean; signature: string; problems: string[] };
  anchor: AnchorView;
}

const ANCHOR_CACHE_MS = 2000;
let anchorCache: { at: number; rows: AnchorEntry[] } | null = null;
export async function loadAnchors(kernel: Kernel): Promise<AnchorEntry[]> {
  if (anchorCache && Date.now() - anchorCache.at < ANCHOR_CACHE_MS) return anchorCache.rows;
  const rows = await kernel.db.txGlobal((tx) => readAnchorLog(tx));
  anchorCache = { at: Date.now(), rows };
  return rows;
}
export const dropAnchorCache = (): void => {
  anchorCache = null;
};

export function anchorViewFor(entries: AnchorEntry[], manifestHash: string): AnchorView {
  const pub = entries.find((e) => e.kind === "publish" && e.manifestHash === manifestHash);
  const commit = entries.find((e) => e.kind === "chain-commit" && e.manifestHash === manifestHash);
  let chain: AnchorView["chain"] = null;
  if (commit) {
    try {
      const p = JSON.parse(commit.payload) as ChainCommitPayload;
      chain = {
        network: p.network,
        contract: p.contract,
        txHash: p.txHash,
        viewTimestampNs: p.viewTimestampNs,
        logSeq: commit.seq,
      };
    } catch {
      chain = null;
    }
  }
  return {
    log: pub
      ? { seq: pub.seq, anchoredAt: pub.anchoredAt, entryHash: pub.entryHash, prevHash: pub.prevHash }
      : null,
    chain,
  };
}

/** Signing key trust of one manifest, from the trusted-publish-keys registry (revocation included). */
export function keyTrustOf(
  m: PublishManifest,
  v: { trusted: boolean; trustReason: string; signerKeyId: string | null },
  registryFile = registryPathFromEnv(),
): KeyTrust {
  if (m.signature.alg !== "ed25519")
    return {
      fingerprint: null,
      keyId: null,
      keyStatus: "unsigned",
      revokedAt: null,
      trusted: false,
      trustReason: v.trustReason,
    };
  let fingerprint: string | null = null;
  try {
    fingerprint = fingerprintOf(m.signature.publicKeyPem);
  } catch {
    fingerprint = null;
  }
  const entry = fingerprint
    ? readRegistry(registryFile).keys.find((k) => k.fingerprint === fingerprint)
    : undefined;
  return {
    fingerprint,
    keyId: m.signature.keyId,
    keyStatus: entry ? entry.status : "unknown",
    revokedAt: entry?.revokedAt ?? null,
    trusted: v.trusted,
    trustReason: v.trustReason,
  };
}

/** Every published version of a capsule (newest first) with its key trust, verification and anchors. */
export function describePublications(
  publishDir: string,
  anchors: AnchorEntry[],
  registryFile = registryPathFromEnv(),
): PublicationRecord[] {
  if (!existsSync(publishDir)) return [];
  const out: PublicationRecord[] = [];
  for (const f of readdirSync(publishDir).filter((n) => n.endsWith(".publish-manifest.json"))) {
    const manifestPath = join(publishDir, f);
    let m: PublishManifest;
    try {
      m = JSON.parse(readFileSync(manifestPath, "utf8")) as PublishManifest;
    } catch {
      continue;
    }
    const v = verifyPublishManifest(join(publishDir, m.version), manifestPath, {
      registry: registryFile,
      anchors,
    });
    out.push({
      version: m.version,
      manifestHash: m.manifestHash,
      bundleHash: m.bundle.bundleHash,
      capsuleHash: m.capsule.capsuleHash,
      signature: {
        alg: m.signature.alg,
        signedAt: m.signature.alg === "ed25519" ? (m.signature.signedAt ?? null) : null,
      },
      key: keyTrustOf(m, v, registryFile),
      verification: { ok: v.ok, signature: v.signature, problems: v.problems.slice(0, 10) },
      anchor: anchorViewFor(anchors, m.manifestHash),
    });
  }
  const t = (r: PublicationRecord) => Date.parse(r.signature.signedAt ?? "") || 0;
  return out.sort((a, b) => t(b) - t(a)).slice(0, 20);
}
