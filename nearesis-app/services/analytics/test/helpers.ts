import { vi } from "vitest";
import { Redis } from "ioredis";
import {
  acquireDataLock,
  createCh,
  cubeReady,
  defaultCubeSecret,
  loadNormalized,
  loadRegistry,
  resetData,
  settleRollups,
  signCubeToken,
  type ClickHouseClient,
  type Registry,
} from "../src/index.ts";
import type { NormalizedOutput } from "../../ingestion/src/normalized/types.ts";

// Cube-backed tests wait for rollups to refresh; the root runner has no per-package vitest config.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

export const CUBE_URL = process.env.NEARESIS_CUBE_URL ?? "http://127.0.0.1:4000";
export const cubeToken = () =>
  signCubeToken(defaultCubeSecret(), { tenantId: "t1", workspaceId: "w1", principalId: "test" });

export interface Env {
  ch: ClickHouseClient;
  redis: Redis;
  registry: Registry;
  close: () => Promise<void>;
}

/** Real ClickHouse + Redis + Cube. Serializes Cube-backed tests through the shared data lock. */
export async function setupEnv(data: NormalizedOutput | null): Promise<Env> {
  const redis = new Redis("redis://127.0.0.1:56379", { maxRetriesPerRequest: 2 });
  const release = await acquireDataLock(redis as never);
  const ch = createCh();
  if (!(await cubeReady(CUBE_URL))) throw new Error(`Cube is not ready at ${CUBE_URL}`);
  if (data) {
    await resetData(ch);
    await loadNormalized(ch, data);
    await settleRollups(ch, CUBE_URL, cubeToken());
  }
  return {
    ch,
    redis,
    registry: loadRegistry(),
    close: async () => {
      await release();
      await ch.close();
      redis.disconnect();
    },
  };
}
