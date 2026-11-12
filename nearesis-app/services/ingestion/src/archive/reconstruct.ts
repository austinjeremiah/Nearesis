import { readFileSync, statSync } from "node:fs";
import type { Db } from "../db.ts";
import { sha256Hex } from "../hash.ts";
import type { AccountChunkDone } from "../backfill/account-run.ts";
import { classifyRawObject, knownHashes, listArchive, type KnownHashes } from "../backfill/replay-raw.ts";
import type { ChunkDone } from "../backfill/state.ts";

/**
 * Rebuilds `ingestion.raw_observations` metadata after the table was lost, from what survives on disk: the
 * content-addressed payload files and the progress files (state.json, bq-state.json, account-state.json).
 *
 * Only verifiable facts are written. Request URLs, request bodies, quote parameters, response statuses and provider
 * event times are not recoverable and are therefore ABSENT (never guessed); every field that is present carries a
 * provenance tag in `envelope.provenance`. The envelope is deliberately not a valid live `RawObservation`
 * (`reconstructed: true`, no sourceURL) so nothing can mistake it for an original capture.
 */
export const RECONSTRUCTION_VERSION = 1;

export type Provenance =
  | "verified_sha256" // recomputed from the payload bytes and equal to the file name
  | "observed_file" // stat of the payload file
  | "inferred_from_payload_shape" // payload structure identifies the provider/content type; no header was archived
  | "progress_file" // taken from a progress file entry that names this hash
  | "reconstructed_from_mtime" // payload file modification time (the immutable store writes once, at first fetch)
  | "postgres_explorer_swaps"; // aggregated from ingestion.explorer_swaps rows that reference this hash

export type ReconKind = "bq-chunk" | "account" | "explorer" | "price" | "1click-quote" | "1click-tokens";
export const PROVIDER_BY_KIND: Record<ReconKind, string> = {
  "bq-chunk": "near-bigquery",
  account: "near-bigquery",
  explorer: "near-explorer",
  price: "coingecko",
  "1click-quote": "intents-1click",
  "1click-tokens": "intents-1click",
};

export interface ReconSource {
  name: string;
  rawRoot: string;
  chunks: Record<string, ChunkDone>;
  accounts: Record<string, AccountChunkDone>;
}

export interface ReconEnvelope {
  reconstructed: true;
  reconstructionVersion: number;
  providerId: string;
  contentType: string;
  payloadObjectHash: string;
  sizeBytes: number;
  fetchedAtUTC: string;
  archiveRoot: string;
  linkage: Record<string, unknown>;
  provenance: Record<string, Provenance>;
  /** Everything deliberately not reconstructed. */
  notRecoverable: string[];
}

const NOT_RECOVERABLE = [
  "sourceURL",
  "request body and parameters",
  "requestFingerprint",
  "responseStatus",
  "providerEventAtUTC",
  "page number and cursor of explorer pages",
  "rate-limit headers",
];

/** Content kind, beyond what the replay classifier knows (it does not recognise 1Click payloads). */
export function classifyForReconstruction(
  hash: string,
  bytes: Uint8Array,
  known: KnownHashes,
): ReconKind | null {
  const k = classifyRawObject(hash, bytes, known);
  if (k !== "unknown") return k;
  const text = new TextDecoder().decode(bytes);
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j) && "quote" in j && "correlationId" in j)
      return "1click-quote";
    if (Array.isArray(j) && j.length > 0 && typeof j[0] === "object" && j[0] && "assetId" in j[0])
      return "1click-tokens";
  } catch {
    /* not JSON */
  }
  return null;
}

export interface ReconPlanItem {
  hash: string;
  kind: ReconKind;
  envelope: ReconEnvelope;
}

export interface ReconSummary {
  files: number;
  planned: number;
  inserted: number;
  alreadyPresent: number;
  skipped: { corrupt: string[]; unclassifiable: number };
  byProvider: Record<string, number>;
  fetchedAtSource: Record<string, number>;
  dryRun: boolean;
}

export interface SwapLinkage {
  count: number;
  minCreatedAt: string | null;
  maxCreatedAt: string | null;
}

/** Pure planning step: reads payload files, verifies hashes, builds envelopes. No database access. */
export function planReconstruction(
  sources: ReconSource[],
  opts: { skippedPageHashes?: string[]; swapLinkage?: Map<string, SwapLinkage> } = {},
): { items: ReconPlanItem[]; summary: Omit<ReconSummary, "inserted" | "alreadyPresent" | "dryRun"> } {
  const items: ReconPlanItem[] = [];
  const seen = new Set<string>();
  const summary = {
    files: 0,
    planned: 0,
    skipped: { corrupt: [] as string[], unclassifiable: 0 },
    byProvider: {} as Record<string, number>,
    fetchedAtSource: {} as Record<string, number>,
  };
  const skipped = new Set(opts.skippedPageHashes ?? []);
  for (const src of sources) {
    const known = knownHashes(src.chunks, src.accounts);
    const chunkOf = new Map(Object.values(src.chunks).map((c) => [c.rawObjectHash, c]));
    const accountOf = new Map(Object.values(src.accounts).map((c) => [c.rawObjectHash, c]));
    for (const f of listArchive(src.rawRoot)) {
      summary.files++;
      const bytes = new Uint8Array(readFileSync(f.path));
      if (sha256Hex(bytes) !== f.hash) {
        summary.skipped.corrupt.push(f.hash);
        continue;
      }
      if (seen.has(f.hash)) continue; // same content in two roots: one row per payload hash
      const kind = classifyForReconstruction(f.hash, bytes, known);
      if (!kind) {
        summary.skipped.unclassifiable++;
        continue;
      }
      const size = statSync(f.path).size;
      const provenance: Record<string, Provenance> = {
        payloadObjectHash: "verified_sha256",
        sizeBytes: "observed_file",
        providerId: "inferred_from_payload_shape",
        contentType: "inferred_from_payload_shape",
      };
      const linkage: Record<string, unknown> = {};
      let fetchedAt = new Date(f.mtimeMs).toISOString();
      let fetchedSource: Provenance = "reconstructed_from_mtime";
      const chunk = chunkOf.get(f.hash);
      const account = accountOf.get(f.hash);
      const done = chunk ?? account;
      if (chunk) {
        provenance.providerId = "progress_file";
        Object.assign(linkage, {
          chunkId: chunk.id,
          family: chunk.family,
          from: chunk.from,
          to: chunk.to,
          jobId: chunk.jobId,
          rows: chunk.rows,
        });
      } else if (account) {
        provenance.providerId = "progress_file";
        Object.assign(linkage, {
          chunkId: account.id,
          from: account.from,
          to: account.to,
          jobId: account.jobId,
          rows: account.rows,
        });
      }
      if (done) {
        // Recorded in the progress file: completion of the job that produced this payload (not the request time).
        fetchedAt = done.completedAtUTC;
        fetchedSource = "progress_file";
        provenance.linkage = "progress_file";
      }
      if (kind === "explorer") {
        if (skipped.has(f.hash)) {
          linkage.quarantinedSkipped = true;
          provenance.linkage = "progress_file";
        }
        const sw = opts.swapLinkage?.get(f.hash);
        if (sw) {
          linkage.explorerSwaps = sw;
          provenance.linkage = "postgres_explorer_swaps";
        }
      }
      provenance.fetchedAtUTC = fetchedSource;
      seen.add(f.hash);
      const provider = PROVIDER_BY_KIND[kind];
      items.push({
        hash: f.hash,
        kind,
        envelope: {
          reconstructed: true,
          reconstructionVersion: RECONSTRUCTION_VERSION,
          providerId: provider,
          contentType: "application/json",
          payloadObjectHash: f.hash,
          sizeBytes: size,
          fetchedAtUTC: fetchedAt,
          archiveRoot: src.name,
          linkage,
          provenance,
          notRecoverable: NOT_RECOVERABLE,
        },
      });
      summary.byProvider[provider] = (summary.byProvider[provider] ?? 0) + 1;
      summary.fetchedAtSource[fetchedSource] = (summary.fetchedAtSource[fetchedSource] ?? 0) + 1;
    }
  }
  summary.planned = items.length;
  return { items, summary };
}

/** Explorer swap counts and created_at range per payload hash, from Postgres (the table that survived the wipe, if it did). */
export async function loadSwapLinkage(db: Db): Promise<Map<string, SwapLinkage>> {
  const r = await db
    .query<{ h: string; n: string; lo: Date | null; hi: Date | null }>(
      `SELECT raw_object_hash h, count(*) n, min(created_at) lo, max(created_at) hi
         FROM ingestion.explorer_swaps GROUP BY raw_object_hash`,
    )
    .catch(() => ({ rows: [] }));
  return new Map(
    r.rows.map((x) => [
      x.h,
      {
        count: Number(x.n),
        minCreatedAt: x.lo?.toISOString() ?? null,
        maxCreatedAt: x.hi?.toISOString() ?? null,
      },
    ]),
  );
}

/**
 * Plans and (unless `dryRun`) inserts. Idempotent: a payload hash that already has any row (original or reconstructed)
 * is never touched, so reruns insert nothing and genuine rows always win over reconstructed ones.
 */
export async function reconstructRawObservations(d: {
  db: Db;
  sources: ReconSource[];
  skippedPageHashes?: string[];
  dryRun: boolean;
}): Promise<ReconSummary> {
  const swapLinkage = await loadSwapLinkage(d.db);
  const { items, summary } = planReconstruction(d.sources, {
    ...(d.skippedPageHashes ? { skippedPageHashes: d.skippedPageHashes } : {}),
    swapLinkage,
  });
  let inserted = 0;
  let alreadyPresent = 0;
  if (!d.dryRun) {
    await d.db.tx(async (c) => {
      for (const it of items) {
        const r = await c.query(
          `INSERT INTO ingestion.raw_observations(provider_id, request_fingerprint, payload_object_hash, fetched_at, envelope, request)
           SELECT $1, $2, $3, $4, $5, NULL
            WHERE NOT EXISTS (SELECT 1 FROM ingestion.raw_observations WHERE payload_object_hash = $3)`,
          [
            it.envelope.providerId,
            `reconstructed:${it.hash}`, // placeholder, not a fingerprint: the request is unrecoverable
            it.hash,
            it.envelope.fetchedAtUTC,
            JSON.stringify(it.envelope),
          ],
        );
        if (r.rowCount) inserted++;
        else alreadyPresent++;
      }
    });
  } else {
    const have = await d.db.query<{ h: string }>(
      "SELECT DISTINCT payload_object_hash h FROM ingestion.raw_observations",
    );
    const set = new Set(have.rows.map((x) => x.h));
    alreadyPresent = items.filter((i) => set.has(i.hash)).length;
  }
  return { ...summary, inserted, alreadyPresent, dryRun: d.dryRun };
}
