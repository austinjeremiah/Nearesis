import { RawObservation } from "@nearesis/contracts";
import type { Db } from "../db.ts";
import { canonicalJson, sha256Hex } from "../hash.ts";
import { redactUrl } from "../http/redact.ts";
import type { ObjectStore } from "./object-store.ts";

export type ProviderId = RawObservation["providerId"];

export interface ArchiveInput {
  providerId: ProviderId;
  adapterVersion: string;
  method: string;
  url: string;
  /** Request body, already redacted. Only used for the fingerprint and the sidecar request record. */
  requestBody?: unknown;
  sourceEnvironment: RawObservation["sourceEnvironment"];
  fetchedAtUTC: string;
  receivedAtUTC: string;
  providerEventAtUTC: string | null;
  providerEventAtNullReason?: string;
  responseStatus: number;
  contentType: string;
  payload: Uint8Array;
  cursorBefore?: string;
  cursorAfter?: string;
  sourceSchemaVersion?: string;
  recordsClaimed?: number;
  recordsParsed?: number;
  rateLimitHeaders?: Record<string, string>;
  privacyVisibility: RawObservation["privacyVisibility"];
  completeness: RawObservation["completeness"];
  warnings?: string[];
}

export interface ArchivedObservation {
  id: number | null;
  observation: RawObservation;
  created: boolean; // false when identical bytes were already archived
}

export function requestFingerprint(method: string, url: string, body?: unknown): string {
  return sha256Hex(canonicalJson({ method: method.toUpperCase(), url: redactUrl(url), body: body ?? null }));
}

/** Builds + validates the envelope, writes the immutable object, and (when a Db is given) the metadata row. */
export class RawArchive {
  constructor(
    readonly store: ObjectStore,
    readonly db: Db | null,
  ) {}

  async archive(i: ArchiveInput): Promise<ArchivedObservation> {
    const { hash, created } = await this.store.put(i.payload);
    const url = redactUrl(i.url);
    const observation = RawObservation.parse({
      providerId: i.providerId,
      adapterVersion: i.adapterVersion,
      requestFingerprint: requestFingerprint(i.method, i.url, i.requestBody),
      sourceURL: url,
      sourceEnvironment: i.sourceEnvironment,
      fetchedAtUTC: i.fetchedAtUTC,
      providerEventAtUTC: i.providerEventAtUTC,
      ...(i.providerEventAtUTC === null
        ? {
            providerEventAtNullReason:
              i.providerEventAtNullReason ?? "provider reports no event time for this payload",
          }
        : {}),
      receivedAtUTC: i.receivedAtUTC,
      responseStatus: i.responseStatus,
      contentType: i.contentType,
      payloadObjectHash: hash,
      cursorBefore: i.cursorBefore,
      cursorAfter: i.cursorAfter,
      sourceSchemaVersion: i.sourceSchemaVersion,
      recordsClaimed: i.recordsClaimed,
      recordsParsed: i.recordsParsed,
      rateLimitHeaders: i.rateLimitHeaders,
      privacyVisibility: i.privacyVisibility,
      completeness: i.completeness,
      warnings: i.warnings ?? [],
    });
    let id: number | null = null;
    if (this.db) {
      const r = await this.db.query<{ id: string }>(
        `INSERT INTO ingestion.raw_observations(provider_id, request_fingerprint, payload_object_hash, fetched_at, envelope, request)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          observation.providerId,
          observation.requestFingerprint,
          hash,
          observation.fetchedAtUTC,
          JSON.stringify(observation),
          JSON.stringify({ method: i.method.toUpperCase(), url, body: i.requestBody ?? null }),
        ],
      );
      id = Number(r.rows[0]?.id);
    }
    return { id, observation, created };
  }
}
