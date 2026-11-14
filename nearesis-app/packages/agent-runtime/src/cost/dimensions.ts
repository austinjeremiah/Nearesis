/** The nine metered cost dimensions of ch.13 "Cost model" (ClickHouse CPU and IO are metered separately). */
export const COST_DIMENSIONS = [
  "bigquery_bytes_billed",
  "external_requests",
  "ai_tokens",
  "outlayer_compute",
  "clickhouse_cpu",
  "clickhouse_io",
  "object_storage_gb_month",
  "network_egress_bytes",
  "workflow_operations",
] as const;
export type CostDimension = (typeof COST_DIMENSIONS)[number];

export const COST_UNITS: Record<CostDimension, string> = {
  bigquery_bytes_billed: "bytes",
  external_requests: "requests",
  ai_tokens: "tokens",
  outlayer_compute: "compute_units",
  clickhouse_cpu: "cpu_microseconds",
  clickhouse_io: "bytes_read",
  object_storage_gb_month: "gb_month",
  network_egress_bytes: "bytes",
  workflow_operations: "operations",
};

export const isCostDimension = (d: string): d is CostDimension =>
  (COST_DIMENSIONS as readonly string[]).includes(d);
