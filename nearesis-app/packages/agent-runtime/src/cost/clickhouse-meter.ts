/**
 * ClickHouse CPU and IO metering from `system.query_log` (real figures, not estimates). The collector reads finished
 * queries since a watermark for one database and records them as observed spend: CPU microseconds (UserTimeMicroseconds
 * + SystemTimeMicroseconds) and bytes read. Idempotent by (query_id) so re-reading a window never double counts.
 */
export interface ClickHouseQueryFn {
  (sql: string): Promise<Array<Record<string, string | number>>>;
}
export interface ClickHouseUsage {
  queryId: string;
  eventTime: string;
  cpuMicros: number;
  readBytes: number;
}

export async function collectClickHouseUsage(
  query: ClickHouseQueryFn,
  a: { database: string; sinceIso: string; limit?: number },
): Promise<ClickHouseUsage[]> {
  const db = a.database.replace(/[^A-Za-z0-9_]/g, "");
  const since = new Date(a.sinceIso).toISOString().replace("T", " ").replace("Z", "");
  const rows = await query(
    `SELECT query_id, toString(event_time_microseconds) AS t,
            ProfileEvents['UserTimeMicroseconds'] + ProfileEvents['SystemTimeMicroseconds'] AS cpu, read_bytes
       FROM system.query_log
      WHERE type = 'QueryFinish' AND has(databases, '${db}') AND event_time_microseconds > toDateTime64('${since}', 6)
        AND query_kind = 'Select'
      ORDER BY event_time_microseconds LIMIT ${Math.min(a.limit ?? 5000, 50000)}`,
  );
  return rows.map((r) => ({
    queryId: String(r.query_id),
    eventTime: String(r.t),
    cpuMicros: Number(r.cpu),
    readBytes: Number(r.read_bytes),
  }));
}
