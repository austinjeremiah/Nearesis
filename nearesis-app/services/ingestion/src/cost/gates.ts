import { gatedSpend, spendKey, type SpendGate } from "@nearesis/contracts";
import type { BigQueryJobLike, BigQueryLike } from "../adapters/bigquery.ts";
import type { ObjectStore } from "../archive/object-store.ts";
import { sha256Hex } from "../hash.ts";
import type { FetchImpl } from "../http/client.ts";

/**
 * Spend gating for the ingestion adapters (ch.13 cost model, `NEARESIS_COST_CONTROL=1`). Each wrapper sits at the
 * narrowest seam below the existing guards, so every caller (the backfill runner, the scheduler, the account phase,
 * the guarded adapter) is covered and a refused spend never reaches the provider. The existing BigQuery 95% daily quota
 * guard and per-run ledger stay in front of these; the governor is in addition.
 */

export const PAID_OP_BIGQUERY = "bigquery_query";
export const PAID_OP_PAID_API = "paid_api";

const GB = 1e9;

/** BigQuery: dry runs pass through (free). A billed job is authorised against its dry-run estimate and settled with billed bytes. */
export function gateBigQuery(bq: BigQueryLike, gate: SpendGate | undefined): BigQueryLike {
  if (!gate) return bq;
  const estimates = new Map<string, number>();
  return {
    getProjectId: () => bq.getProjectId(),
    getDatasetMetadata: (p, d) => bq.getDatasetMetadata(p, d),
    async createQueryJob(opts) {
      if (opts.dryRun) {
        const out = await bq.createQueryJob(opts);
        const s = out[0].metadata.statistics;
        const est = Number(s?.totalBytesProcessed ?? s?.query?.totalBytesProcessed ?? Number.NaN);
        if (Number.isFinite(est)) {
          if (estimates.size > 512) estimates.clear();
          estimates.set(opts.query, est);
        }
        return out;
      }
      const cap = opts.maximumBytesBilled !== undefined ? Number(opts.maximumBytesBilled) : Number.NaN;
      const known = estimates.get(opts.query);
      // Without a dry-run estimate the only safe upper bound is the job's own cap; with neither, refuse to guess.
      const estimate = known ?? (Number.isFinite(cap) ? cap : Number.NaN);
      if (!Number.isFinite(estimate)) {
        const e = new Error("bigquery job has neither a dry-run estimate nor maximumBytesBilled");
        e.name = "SpendGateError";
        throw e;
      }
      const key = spendKey(`bq:${opts.labels?.source ?? "job"}`);
      let settled = false;
      const conservative = Number.isFinite(cap) ? cap : estimate;
      const settleOnce = async (quantity: number): Promise<void> => {
        if (settled) return;
        settled = true;
        await gate.settle(key, { quantity });
      };
      await gate.authorize({
        key,
        dimension: "bigquery_bytes_billed",
        quantity: Number.isFinite(cap) ? Math.min(estimate, cap) : estimate,
        paidOp: PAID_OP_BIGQUERY,
        detail: {
          source: opts.labels?.source ?? null,
          location: opts.location ?? null,
          estimateBytes: estimate,
        },
      });
      let job: BigQueryJobLike;
      try {
        [job] = await bq.createQueryJob(opts);
      } catch (e) {
        settled = true;
        await gate.release(key);
        throw e;
      }
      return [
        new Proxy(job, {
          get(t, p) {
            if (p === "getQueryResults")
              return async () => {
                let r: Awaited<ReturnType<BigQueryJobLike["getQueryResults"]>>;
                try {
                  r = await t.getQueryResults();
                } catch (e) {
                  await settleOnce(conservative); // the job ran; a failed read is not proof it was free
                  throw e;
                }
                let billed = Number(t.metadata.statistics?.query?.totalBytesBilled ?? Number.NaN);
                if (!Number.isFinite(billed)) {
                  const refresh = (t as { getMetadata?: () => Promise<[BigQueryJobLike["metadata"]]> })
                    .getMetadata;
                  if (refresh) {
                    const [m] = await refresh.call(t);
                    billed = Number(m.statistics?.query?.totalBytesBilled ?? Number.NaN);
                  }
                }
                await settleOnce(Number.isFinite(billed) ? billed : conservative);
                return r;
              };
            const v: unknown = Reflect.get(t, p, t);
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          },
        }),
      ];
    },
  };
}

/** Raw archive storage: a new object is authorised (bytes as GB-months, one month retained) before it is written. */
export function gateObjectStore(store: ObjectStore, gate: SpendGate | undefined): ObjectStore {
  if (!gate) return store;
  const write = async (
    bytes: Uint8Array,
    hash: string,
    doPut: () => Promise<{ hash: string; created: boolean }>,
  ) => {
    if (await store.has(hash)) return doPut(); // already stored: write-once, nothing new to pay for
    return gatedSpend(
      gate,
      {
        key: spendKey("store"),
        dimension: "object_storage_gb_month",
        quantity: bytes.byteLength / GB,
        detail: { bytes: bytes.byteLength },
      },
      async () => {
        const r = await doPut();
        return { result: r, quantity: r.created ? bytes.byteLength / GB : 0 };
      },
    );
  };
  return {
    put: (bytes) => write(bytes, sha256Hex(bytes), () => store.put(bytes)),
    putAt: (key, bytes) => write(bytes, key, () => store.putAt(key, bytes)),
    get: (h) => store.get(h),
    has: (h) => store.has(h),
  };
}

export interface HttpSpendOptions {
  /** Returns the paid operation name for hosts whose calls cost money (e.g. a pro API), else undefined (metered only). */
  paidOp?: (host: string) => string | undefined;
}

/**
 * Outbound HTTP: every request is one `external_requests` unit authorised before the socket is opened (paid hosts
 * additionally need the paid-operation permission). Request and response bytes are metered as `network_egress_bytes`.
 */
export function gateFetch(
  inner: FetchImpl,
  gate: SpendGate | undefined,
  o: HttpSpendOptions = {},
): FetchImpl {
  if (!gate) return inner;
  return async (url, init) => {
    const host = new URL(url).hostname;
    const paidOp = o.paidOp?.(host);
    return gatedSpend(
      gate,
      {
        key: spendKey("http"),
        dimension: "external_requests",
        quantity: 1,
        ...(paidOp ? { paidOp } : {}),
        detail: { host, method: init.method },
      },
      async () => {
        const res = await inner(url, init);
        const body = await res.arrayBuffer();
        const sent = init.body ? Buffer.byteLength(init.body) : 0;
        await gate.observe({
          key: spendKey("egress"),
          dimension: "network_egress_bytes",
          quantity: sent + body.byteLength,
          detail: { host },
        });
        return {
          result: { status: res.status, headers: res.headers, arrayBuffer: async () => body },
          quantity: 1,
        };
      },
    );
  };
}

/** Default paid hosts of the ingestion providers: CoinGecko Pro is a paid API; the 1Click quote API and Explorer are metered only. */
export const ingestionPaidOp = (host: string): string | undefined =>
  host === "pro-api.coingecko.com" ? PAID_OP_PAID_API : undefined;
