import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFixtureJson } from "@nearesis/test-fixtures";
import { Redis } from "ioredis";
import { RawArchive } from "../../src/archive/archive.ts";
import { FsObjectStore } from "../../src/archive/object-store.ts";
import { ExplorerCollector, type ExplorerDeps } from "../../src/adapters/explorer.ts";
import { FakeClock, type Clock } from "../../src/clock.ts";
import { ALLOW_EXPLORER, HttpClient, type FetchImpl } from "../../src/http/client.ts";
import { CredentialSource } from "../../src/http/credentials.ts";
import { createTestDb, type TestDb } from "../../src/testing/test-db.ts";

export const REDIS_URL = "redis://127.0.0.1:56379";
export const uniqueJwt = (): string => `fixture-jwt-${randomBytes(8).toString("hex")}`;

export interface TestEnv {
  tdb: TestDb;
  redis: Redis;
  tmp: string;
  store: FsObjectStore;
  archive: RawArchive;
  clock: FakeClock;
  jwt: string;
  creds: CredentialSource;
  collector(fetchImpl: FetchImpl, over?: Partial<ExplorerDeps> & { clock?: Clock }): ExplorerCollector;
  close(): Promise<void>;
}

export async function setupEnv(): Promise<TestEnv> {
  const tdb = await createTestDb();
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  const tmp = mkdtempSync(join(tmpdir(), "ingestion-test-"));
  const store = new FsObjectStore(join(tmp, "raw"));
  const archive = new RawArchive(store, tdb.db);
  const clock = new FakeClock();
  const jwt = uniqueJwt();
  const creds = CredentialSource.fromMap({ INTENTS_EXPLORER_JWT: jwt });
  const env: TestEnv = {
    tdb,
    redis,
    tmp,
    store,
    archive,
    clock,
    jwt,
    creds,
    collector(fetchImpl, over = {}) {
      const c = over.clock ?? clock;
      const http = new HttpClient({ allow: [ALLOW_EXPLORER], fetchImpl, credentials: creds, clock: c });
      return new ExplorerCollector({
        http,
        archive,
        db: tdb.db,
        redis,
        clock: c,
        credentials: creds,
        pageSize: 5,
        blockerDir: join(tmp, "blockers"),
        sourceEnvironment: "fixture_synthetic",
        ...over,
      });
    },
    async close() {
      redis.disconnect();
      await tdb.drop();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
  return env;
}

export function loadPages(fixtureId: string): Record<string, unknown>[][] {
  const idx = readFixtureJson<{ pages: string[] }>(fixtureId, "pages.json");
  return idx.pages.map((f) => readFixtureJson<Record<string, unknown>[]>(fixtureId, f));
}

export const keysOf = (pages: Record<string, unknown>[][]): string[] =>
  pages.flat().map((t) => `${t.depositAddress as string}|${(t.depositMemo as string | null) ?? ""}`);
