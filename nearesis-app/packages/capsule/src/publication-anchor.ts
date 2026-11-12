import { createHash } from "node:crypto";

/**
 * Independent append-only publication record. A manifest's `signedAt` is asserted by the key holder, so a stolen key can
 * backdate it. Each published manifest hash is therefore also appended to a hash-chained log with the log's own clock
 * (Postgres, packages/kernel/migrations/018_publication_anchor.sql: the trigger builds seq/prev/hash/time and refuses
 * UPDATE, DELETE and TRUNCATE) and its hash is committed on NEAR testnet (hash only). Verification trusts a revoked key's
 * manifest only when the log/chain time is not after the revocation. See docs/publishing-key-hardening.md.
 */
export const GENESIS_HASH = "0".repeat(64);

export interface AnchorEntry {
  seq: number;
  kind: "publish" | "chain-commit";
  manifestHash: string;
  /** Signer-asserted (publish entries); empty otherwise. NOT trusted for time. */
  signedAt: string;
  /** Canonical-JSON text exactly as stored. */
  payload: string;
  /** ISO-8601 UTC with microseconds, from the log's clock. */
  anchoredAt: string;
  prevHash: string;
  entryHash: string;
}
export interface ChainCommitPayload {
  network: string;
  contract: string;
  txHash: string;
  /** Block timestamp (ns since epoch) at which the contract view returned the commitment; an upper bound on commit time. */
  viewTimestampNs: string;
}

export const entryHashOf = (e: Omit<AnchorEntry, "entryHash">): string =>
  createHash("sha256")
    .update(
      `${e.seq}|${e.kind}|${e.manifestHash}|${e.signedAt}|${e.anchoredAt}|${e.payload}|${e.prevHash}`,
      "utf8",
    )
    .digest("hex");

/** Genesis, contiguous seq, prev links and recomputed hashes. Returns the problems (empty = chain intact). */
export function verifyAnchorChain(entries: AnchorEntry[]): string[] {
  const problems: string[] = [];
  let prev = GENESIS_HASH;
  entries.forEach((e, i) => {
    if (e.seq !== i + 1) problems.push(`entry ${i}: seq ${e.seq} is not ${i + 1}`);
    if (e.prevHash !== prev) problems.push(`entry ${e.seq}: prev_hash does not link to the previous entry`);
    if (entryHashOf(e) !== e.entryHash) problems.push(`entry ${e.seq}: entry hash does not recompute`);
    prev = e.entryHash;
  });
  return problems;
}

/**
 * Earliest independent time at which `manifestHash` is proven to have existed: the log time of its publish entry or the
 * chain commit's view time, whichever is earlier. null when the chain is broken or the manifest is not in the log.
 */
export function anchoredTimeFor(entries: AnchorEntry[], manifestHash: string): string | null {
  if (verifyAnchorChain(entries).length > 0) return null;
  const times: number[] = [];
  for (const e of entries) {
    if (e.manifestHash !== manifestHash) continue;
    if (e.kind === "publish") times.push(Date.parse(e.anchoredAt));
    else {
      try {
        const p = JSON.parse(e.payload) as ChainCommitPayload;
        if (p.network === "testnet" && /^\d+$/.test(p.viewTimestampNs))
          times.push(Number(BigInt(p.viewTimestampNs) / 1_000_000n));
      } catch {
        /* an unreadable chain-commit entry proves nothing */
      }
    }
  }
  const ok = times.filter(Number.isFinite);
  return ok.length ? new Date(Math.min(...ok)).toISOString() : null;
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}
const COLS = `seq::int AS seq, kind, manifest_hash, signed_at, payload,
  to_char(anchored_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS anchored_at, prev_hash, entry_hash`;
const toEntry = (r: Record<string, unknown>): AnchorEntry => ({
  seq: Number(r.seq),
  kind: r.kind as AnchorEntry["kind"],
  manifestHash: String(r.manifest_hash),
  signedAt: String(r.signed_at),
  payload: String(r.payload),
  anchoredAt: String(r.anchored_at),
  prevHash: String(r.prev_hash),
  entryHash: String(r.entry_hash),
});

/** Append a publish entry (the trigger assigns seq, links, time and hash). */
export async function appendPublishAnchor(
  db: Queryable,
  a: {
    manifestHash: string;
    signedAt: string | null;
    capsuleId: string;
    version: string;
    keyFingerprint: string | null;
  },
): Promise<AnchorEntry> {
  const payload = JSON.stringify({
    capsuleId: a.capsuleId,
    version: a.version,
    keyFingerprint: a.keyFingerprint,
  });
  const r = await db.query(
    `INSERT INTO publication_anchor_log (kind, manifest_hash, signed_at, payload, seq, anchored_at, prev_hash, entry_hash)
     VALUES ('publish', $1, $2, $3, 0, now(), '', '') RETURNING ${COLS}`,
    [a.manifestHash, a.signedAt ?? "", payload],
  );
  return toEntry(r.rows[0]!);
}
/** Append the NEAR commitment record for a manifest hash. */
export async function appendChainCommitAnchor(
  db: Queryable,
  a: { manifestHash: string } & ChainCommitPayload,
): Promise<AnchorEntry> {
  const { manifestHash, ...p } = a;
  const r = await db.query(
    `INSERT INTO publication_anchor_log (kind, manifest_hash, signed_at, payload, seq, anchored_at, prev_hash, entry_hash)
     VALUES ('chain-commit', $1, '', $2, 0, now(), '', '') RETURNING ${COLS}`,
    [manifestHash, JSON.stringify(p)],
  );
  return toEntry(r.rows[0]!);
}
export async function readAnchorLog(db: Queryable): Promise<AnchorEntry[]> {
  const r = await db.query(`SELECT ${COLS} FROM publication_anchor_log ORDER BY seq`);
  return r.rows.map(toEntry);
}
