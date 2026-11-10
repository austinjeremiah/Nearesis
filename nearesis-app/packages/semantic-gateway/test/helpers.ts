import { Redis } from "ioredis";
import {
  acquireDataLock,
  createCh,
  cubeReady,
  defaultCubeSecret,
  loadNormalized,
  loadLatestRegistryForTests,
  resetData,
  settleRollups,
  signCubeToken,
  type ClickHouseClient,
  type Registry,
} from "@nearesis/analytics";
import type { NormalizedOutput } from "../../../services/ingestion/src/normalized/types.ts";
import { createGateway, DEFAULT_POLICY, type Policy, type Session } from "../src/index.ts";

export const CUBE_URL = process.env.NEARESIS_CUBE_URL ?? "http://127.0.0.1:4000";
export const W1: Session = { tenantId: "t1", workspaceId: "w1", principalId: "p1", aclClasses: ["member"] };
export const W2: Session = { tenantId: "t2", workspaceId: "w2", principalId: "p2", aclClasses: ["member"] };

export function ast(over: Record<string, unknown> = {}) {
  return {
    semanticVersion: "1.0.0",
    measures: ["intents.oneclick_completed_swap_count"],
    dimensions: [],
    time: { field: "intents.day", from: "2026-10-01T00:00:00Z", to: "2026-10-11T00:00:00Z", grain: "day" },
    filters: [],
    order: [],
    limit: 1000,
    ...over,
  };
}

export interface Env {
  ch: ClickHouseClient;
  redis: Redis;
  registry: Registry;
  release: () => Promise<void>;
  close: () => Promise<void>;
  gateway: (opts?: {
    registry?: Registry;
    policy?: (s: Session) => Policy;
    pg?: import("pg").Pool;
  }) => ReturnType<typeof createGateway>;
}

/** Real ClickHouse + Redis + Cube. Takes the shared data lock, loads `data` into the Cube database, clears gateway cache keys. */
export async function setupEnv(data: NormalizedOutput | null): Promise<Env> {
  const redis = new Redis("redis://127.0.0.1:56379", { maxRetriesPerRequest: 2 });
  const release = await acquireDataLock(redis as never);
  const ch = createCh();
  if (data) {
    await resetData(ch);
    await loadNormalized(ch, data);
  }
  const keys = await redis.keys("semantic:q:*");
  if (keys.length) await redis.del(...keys);
  const registry = loadLatestRegistryForTests();
  if (!(await cubeReady(CUBE_URL))) throw new Error("Cube is not ready at " + CUBE_URL);
  if (data) await settle(ch);
  return {
    ch,
    redis,
    registry,
    release,
    close: async () => {
      await release();
      await ch.close();
      redis.disconnect();
    },
    gateway: (o = {}) =>
      createGateway({
        cubeUrl: CUBE_URL,
        cubeSecret: defaultCubeSecret(),
        redis: redis as never,
        registry: o.registry ?? registry,
        policyResolver: o.policy ?? (() => ({ ...DEFAULT_POLICY })),
        clock: () => new Date("2026-11-10T12:00:00Z"),
        ch,
        pg: o.pg,
      }),
  };
}

export const cubeToken = () =>
  signCubeToken(defaultCubeSecret(), { tenantId: "t1", workspaceId: "w1", principalId: "test" });
/** Waits until Cube rollups reflect the data currently in ClickHouse (call after every mid-test load). */
export const settle = (ch: ClickHouseClient) => settleRollups(ch, CUBE_URL, cubeToken());
