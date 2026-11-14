import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { reconstructRawObservations, type ReconSource } from "../../src/archive/reconstruct.ts";
import { DEFAULT_DATABASE_URL } from "../../src/db.ts";
import { openLivePg, tempName } from "../../src/backfill/env.ts";
import { sha256Hex } from "../../src/hash.ts";

const name = tempName();
const root = mkdtempSync(join(tmpdir(), "recon-db-"));
const body = '[{"originAsset":"a"}]';
const hash = sha256Hex(new TextEncoder().encode(body));
mkdirSync(join(root, hash.slice(0, 2)), { recursive: true });
writeFileSync(join(root, hash.slice(0, 2), hash), body);
const sources: ReconSource[] = [{ name: "backfill", rawRoot: root, chunks: {}, accounts: {} }];

afterAll(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.end();
});

describe("reconstruction against Postgres", () => {
  it("dry run writes nothing; apply inserts once; rerun is a no-op; real rows are never overwritten", async () => {
    const live = await openLivePg(name);
    try {
      const count = async () =>
        Number((await live.db.query("SELECT count(*) n FROM ingestion.raw_observations")).rows[0]!.n);
      const dry = await reconstructRawObservations({ db: live.db, sources, dryRun: true });
      expect([dry.planned, dry.inserted, await count()]).toEqual([1, 0, 0]);
      const first = await reconstructRawObservations({ db: live.db, sources, dryRun: false });
      expect([first.inserted, await count()]).toEqual([1, 1]);
      const second = await reconstructRawObservations({ db: live.db, sources, dryRun: false });
      expect([second.inserted, second.alreadyPresent, await count()]).toEqual([0, 1, 1]);
      const row = (
        await live.db.query(
          "SELECT provider_id, fetched_at, envelope, request FROM ingestion.raw_observations",
        )
      ).rows[0]!;
      expect(row.provider_id).toBe("near-explorer");
      expect(row.request).toBeNull();
      expect(row.envelope.provenance.fetchedAtUTC).toBe("reconstructed_from_mtime");
    } finally {
      await live.db.close();
    }
  }, 60_000);
});
