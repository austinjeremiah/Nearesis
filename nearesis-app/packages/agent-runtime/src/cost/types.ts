import type { CostDimension } from "./dimensions.ts";

/** Minimal query surface shared by pg.Pool clients and the kernel's Tx, so one SQL body serves the runtime and the API. */
export interface Querier {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are mapped immediately at each call site
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface CostPolicy {
  tenantId: string;
  workspaceId: string;
  capUsd: number;
  periodStart: string;
  periodDays: number;
  dimensionLimits: Partial<Record<CostDimension, number>>;
  rates: Partial<Record<CostDimension, number>>;
  paidOpsPermitted: string[];
  inflightAllowanceUsd: number;
  alertThresholds: number[];
  alertMaxPerWindow: number;
  alertWindowSeconds: number;
  alertCooldownSeconds: number;
  hardStoppedAt: string | null;
  hardStopReason: string | null;
}

export type PolicyInput = Partial<
  Omit<CostPolicy, "tenantId" | "workspaceId" | "hardStoppedAt" | "hardStopReason">
> & { capUsd: number };

export interface AlertPayload {
  tenantId: string | null;
  workspaceId: string | null;
  key: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: Record<string, unknown>;
}

/** Delivery of a sent (not suppressed) alert. The production sink is `kernelAlertSink` (event journal + audit). */
export interface AlertSink {
  send(a: AlertPayload): Promise<void>;
}
