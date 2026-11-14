import { gatedSpend, spendKey, type SpendGate } from "@nearesis/contracts";

/**
 * OutLayer job submission with cost control (ch.13 cost model, `NEARESIS_COST_CONTROL=1`). A job costs compute units at
 * a provider, so it is a paid operation: it is AUTHORISED before the transport is called (a refused spend never
 * reaches OutLayer) against the job's compute ceiling, and SETTLED with the units the provider reports. The
 * transport is injected; this module opens no connection itself.
 */
export interface OutlayerJob {
  /** Stable id of the job (task) being submitted. */
  jobId: string;
  /** Compute-unit ceiling the job may consume; the authorised estimate. */
  maxComputeUnits: number;
  input: unknown;
}
export interface OutlayerJobResult {
  status: "succeeded" | "failed";
  /** Compute units the provider actually charged. */
  computeUnitsUsed: number;
  output?: unknown;
}
export interface OutlayerTransport {
  submit(job: OutlayerJob): Promise<OutlayerJobResult>;
}

export const OUTLAYER_PAID_OP = "outlayer_job";

export async function submitOutlayerJob(
  d: { transport: OutlayerTransport; gate?: SpendGate },
  job: OutlayerJob,
): Promise<OutlayerJobResult> {
  if (!Number.isFinite(job.maxComputeUnits) || job.maxComputeUnits < 0)
    throw new Error("maxComputeUnits must be a finite number >= 0");
  return gatedSpend(
    d.gate,
    {
      key: spendKey(`outlayer:${job.jobId}`),
      dimension: "outlayer_compute",
      quantity: job.maxComputeUnits,
      paidOp: OUTLAYER_PAID_OP,
      detail: { jobId: job.jobId },
    },
    async () => {
      const r = await d.transport.submit(job);
      // A failed job may still have been charged: settle what the provider reports either way.
      return { result: r, quantity: r.computeUnitsUsed };
    },
  );
}
