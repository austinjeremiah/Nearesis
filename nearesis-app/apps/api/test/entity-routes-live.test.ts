import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

/** Real stack: the app's own auth plus the live ClickHouse registry (v1 loaded by services/ingestion/src/entities/load-cli.ts). */
let f: ApiFixture;
let tok: string;
let live = false;
beforeAll(async () => {
  try {
    const r = await fetch("http://127.0.0.1:58123/ping");
    live = r.ok;
  } catch {
    live = false;
  }
  f = await apiFixture();
  const o = await seedOrg(f.db.admin, "ent", { alice: "viewer" });
  tok = await login(f.app, o.users.alice!.subject);
}, 60_000);
afterAll(async () => f?.close());

describe("entity API against live data", () => {
  it("is unavailable without a session", async () => {
    expect((await f.app.inject({ url: "/v1/entities/changes" })).statusCode).toBe(401);
  });
  it.skipIf(!process.env.RUN_LIVE_STACK)(
    "answers the 90-day question from nearesis_live with coverage",
    async () => {
      expect(live).toBe(true);
      const r = await f.app.inject({ url: "/v1/entities/changes?days=90&limit=5", headers: bearer(tok) });
      expect(r.statusCode).toBe(200);
      const b = r.json() as {
        registryVersion: string;
        entities: Array<{ entityId: string; change: number }>;
        currentCoverage: { classifiedShare: number; missingDays: string[] };
        uniqueUsers: { state: string };
      };
      expect(b.registryVersion).toBe("v1");
      expect(b.entities).toHaveLength(5);
      expect(b.entities[0]!.change).toBeGreaterThan(0);
      expect(b.currentCoverage.classifiedShare).toBeGreaterThan(0);
      expect(b.currentCoverage.classifiedShare).toBeLessThan(1);
      expect(b.uniqueUsers.state).toBe("CANNOT_COMPUTE");
    },
  );
});
