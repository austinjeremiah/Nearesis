import { Redis } from "ioredis";
import {
  createCh,
  defaultCubeSecret,
  LIVE_CUBE_URL_DEFAULT,
  LIVE_DATABASE,
  loadLiveRegistry,
} from "@nearesis/analytics";
import { createGateway, DEFAULT_POLICY, type Session } from "@nearesis/semantic-gateway";
import type { WatermarkEvent } from "@nearesis/contracts";
import { MonitorFeeder, type FeederDeps, type WatermarkRow } from "./monitor-feeder.ts";
import { DegradationGuard } from "./overload/index.ts";

const DAY_MS = 86_400_000;
const FEEDER_SESSION: Session = {
  tenantId: "system",
  workspaceId: "system",
  principalId: "monitor-feeder",
  aclClasses: ["human"],
};

/** Production wiring: ClickHouse `nearesis_live.source_watermarks` for rows, the LIVE semantic gateway for values. */
export function liveFeederDeps(enqueue: (e: WatermarkEvent) => Promise<{ enqueued: boolean }>) {
  const ch = createCh({ database: LIVE_DATABASE });
  const registry = loadLiveRegistry();
  const redis = new Redis(process.env.NEARESIS_REDIS_URL ?? "redis://127.0.0.1:56379", {
    maxRetriesPerRequest: 2,
  });
  const gateway = createGateway({
    cubeUrl: process.env.CUBE_LIVE_URL ?? LIVE_CUBE_URL_DEFAULT,
    cubeSecret: defaultCubeSecret(),
    redis: redis as never,
    registry,
    policyResolver: () => ({ ...DEFAULT_POLICY }),
    clock: () => new Date(),
    ch,
  });
  const byId = new Map(registry.metrics.map((m) => [m.id, m]));
  const deps: FeederDeps = {
    async readWatermarks(after: number): Promise<WatermarkRow[]> {
      const rs = await ch.query({
        query:
          "SELECT provider_id, toString(newest_event_time) AS t, state, version FROM source_watermarks FINAL WHERE version > {v:UInt64} ORDER BY version ASC LIMIT 1000",
        query_params: { v: after },
        format: "JSONEachRow",
      });
      return (
        (await rs.json()) as Array<{ provider_id: string; t: string | null; state: string; version: string }>
      ).map((r) => ({
        providerId: r.provider_id,
        newestEventTime: r.t === null || r.t.startsWith("1970") ? null : r.t,
        state: r.state,
        version: Number(r.version),
      }));
    },
    metricIdsFor: (provider) =>
      registry.metrics.filter((m) => m.sources.some((s) => s.startsWith(`${provider}:`))).map((m) => m.id),
    async metricValue(metricId, watermarkIso) {
      const m = byId.get(metricId);
      if (!m) return null;
      const view = m.cubeMember.slice(0, m.cubeMember.indexOf("."));
      const dayStart = Math.floor(Date.parse(watermarkIso) / DAY_MS) * DAY_MS;
      const r = await gateway.query(FEEDER_SESSION, {
        semanticVersion: registry.semanticVersion,
        measures: [m.id],
        dimensions: [],
        time: {
          field: `${view}.day`,
          from: new Date(dayStart).toISOString(),
          to: new Date(dayStart + DAY_MS).toISOString(),
          grain: "day",
        },
        filters: [],
        order: [],
        limit: 10,
      });
      if (!r.ok) return null;
      const env = r.envelope;
      const col = env.columns.findIndex((c) => c.name === m.cubeMember || c.name === m.id);
      const idx = col >= 0 ? col : env.columns.findIndex((c) => c.type === "number" || c.type === "decimal");
      const row = env.rows.at(-1);
      if (!row || idx < 0 || env.rowCoverage?.at(-1) === "unavailable") return null;
      const cell = row[idx];
      const n = typeof cell === "number" ? cell : typeof cell === "string" ? Number(cell) : Number.NaN;
      return Number.isFinite(n) ? n : null;
    },
    enqueue,
  };
  return {
    deps,
    async close() {
      await ch.close();
      redis.disconnect();
    },
  };
}

/** Background service: runs the feeder inside the API process (NEARESIS_MONITOR_BACKGROUND=1). */
export function startLiveMonitorFeeder(
  kernel: { monitorScheduler(): { enqueue(e: WatermarkEvent): Promise<{ enqueued: boolean }> } },
  app: { addHook(name: "onClose", fn: () => Promise<void>): unknown },
  opts: { intervalMs?: number } = {},
): MonitorFeeder {
  const scheduler = kernel.monitorScheduler();
  const live = liveFeederDeps((e) => scheduler.enqueue(e));
  const degradation = new DegradationGuard<Record<string, number>>({ openMs: 60_000, maxOpenMs: 600_000 });
  const feeder = new MonitorFeeder({
    ...live.deps,
    degradation,
    log: (m) => console.log(`[monitor-feeder] ${m}`),
  });
  feeder.start(opts.intervalMs ?? Number(process.env.NEARESIS_MONITOR_FEEDER_INTERVAL_MS ?? 30_000));
  app.addHook("onClose", async () => {
    await feeder.stop();
    await live.close();
  });
  return feeder;
}
