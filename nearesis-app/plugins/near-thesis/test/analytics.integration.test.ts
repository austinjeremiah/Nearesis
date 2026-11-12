/**
 * intents.analyze@1, entities.analyze@1 and accounts.analyze@1 through the real kernel: signed install of the current
 * manifest (artifact hash check), per-capability grants, typed OK and CANNOT_COMPUTE outcomes on the real live warehouse
 * (read only), the live-source gate and input bounds. Needs Postgres and ClickHouse (nearesis_live).
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnalyticsOutcome } from "@nearesis/contracts";
import type { Principal } from "@nearesis/contracts";
import type { Kernel, Session } from "@nearesis/kernel";
import {
  createTestDb,
  createWs,
  execReq,
  giveLease,
  grant,
  loginSession,
  pluginUp,
  seedOrg,
  TEST_KEY,
  TEST_PUBLISHER,
  testKernel,
  type TestDb,
} from "@nearesis/kernel/testing";
import {
  buildManifest,
  CAPABILITIES,
  ENTRY_FILE,
  NEAR_THESIS_DESCRIPTOR,
  PLUGIN_ROOT,
  registerRunSource,
} from "../src/index.ts";

const IDS = ["intents.analyze@1", "entities.analyze@1", "accounts.analyze@1"] as const;
const GRANT = {
  "intents.analyze@1": "intents",
  "entities.analyze@1": "entities",
  "accounts.analyze@1": "accounts",
} as const;
const SAMPLE = {
  "intents.analyze@1": { analysis: "status", days: 14, grain: "week" },
  "entities.analyze@1": { analysis: "changes", days: 30, limit: 5 },
  "accounts.analyze@1": { analysis: "daily", days: 14 },
} as const;

let db: TestDb;
let k: Kernel;
let s: Session;
let ws: string;
const liveRun = randomUUID();
const fixtureRun = randomUUID();
const asRun = (runId: string): Principal => ({ ...s.principal, parentRunId: runId }) as Principal;

beforeAll(async () => {
  registerRunSource(liveRun, "live");
  registerRunSource(fixtureRun, "fixture");
  db = await createTestDb();
  const org = await seedOrg(db.admin, "nt-an", { alice: "owner" });
  k = testKernel(db, { pluginRoot: PLUGIN_ROOT });
  await k.boot();
  s = await loginSession(k, org.users.alice!.subject);
  const w = await createWs(k, s);
  ws = w.workspaceId;
  await k.plugins.install(
    s.principal.actorId,
    buildManifest({ publisher: TEST_PUBLISHER, privateKey: TEST_KEY.privateKey }),
  );
  await k.plugins.enable(s.principal.actorId, "near-thesis");
  await pluginUp(k, s, ws, w.version, "near-thesis");
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const call = (cap: (typeof IDS)[number], input: unknown, run = liveRun) =>
  k.gateway.invoke(asRun(run), execReq(s, ws, cap, input, { deadlineMs: 60_000 }));

describe("near-thesis manifest and artifact hash", () => {
  it("is 1.5.0, declares the three analytics capabilities with their own grants, and hashes the entry module bytes", () => {
    const m = buildManifest({ publisher: TEST_PUBLISHER });
    expect(m.version).toBe("1.5.0");
    expect(NEAR_THESIS_DESCRIPTOR.version).toBe(m.version);
    expect(m.artifactSha256).toBe(createHash("sha256").update(readFileSync(ENTRY_FILE)).digest("hex"));
    for (const id of IDS) {
      const c = CAPABILITIES.find((x) => x.id === id)!;
      expect(c, id).toBeTruthy();
      expect(c.requiredGrants).toEqual([`analytics:${GRANT[id]}`]);
      expect(c.sideEffect).toBe("read_only");
    }
    expect(m.capabilities.map((c) => c.id)).toEqual(
      expect.arrayContaining([...IDS, "metric.propose@1", "semantic.discover@1"]),
    );
  });
  it("the kernel refuses a manifest whose artifactSha256 does not match the entry module", async () => {
    const bad = buildManifest({
      publisher: TEST_PUBLISHER,
      privateKey: TEST_KEY.privateKey,
      version: "1.4.1",
    });
    bad.artifactSha256 = "0".repeat(64);
    const re = buildManifest({
      publisher: TEST_PUBLISHER,
      privateKey: TEST_KEY.privateKey,
      version: "1.4.1",
    });
    void re;
    const { signManifest } = await import("@nearesis/plugin-sdk");
    const { signature: _s, ...unsigned } = bad;
    void _s;
    const tampered = { ...unsigned, signature: signManifest(unsigned as never, TEST_KEY.privateKey) };
    await expect(k.plugins.install(s.principal.actorId, tampered as never)).rejects.toMatchObject({
      reasonCode: "ARTIFACT_HASH_MISMATCH",
    });
  });
});

describe("analytics capabilities: authorization", () => {
  it("a principal without a lease is refused every capability (TOOL_NOT_GRANTED)", async () => {
    for (const id of IDS) {
      const r = await call(id, SAMPLE[id]);
      expect(r.state, id).toBe("blocked");
      expect(r.reasonCode).toBe("TOOL_NOT_GRANTED");
    }
  });
  it("a lease for another analytics grant does not authorise the capability", async () => {
    await giveLease(k, s, ws, "intents.analyze@1", [grant({ resource: "analytics", action: "accounts" })]);
    const r = await call("intents.analyze@1", SAMPLE["intents.analyze@1"]);
    expect(r.state).toBe("blocked");
    expect(r.reasonCode).toBe("TOOL_NOT_GRANTED");
  });
});

describe("analytics capabilities: typed outputs on the live warehouse", () => {
  beforeAll(async () => {
    for (const id of IDS)
      await giveLease(k, s, ws, id, [grant({ resource: "analytics", action: GRANT[id] })]);
  });

  it.each(IDS)(
    "%s returns a typed ANALYTICS_RESULT with provenance and coverage",
    async (id) => {
      const r = await call(id, SAMPLE[id]);
      expect(r.state, JSON.stringify(r).slice(0, 600)).toBe("ok");
      const { ok, ...rest } = r.payload as { ok: boolean } & Record<string, unknown>;
      expect(ok).toBe(true);
      const o = AnalyticsOutcome.parse(rest);
      expect(o.label).toBe("ANALYTICS_RESULT");
      expect(o.certification).toBe("SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC");
      expect(o.capability).toBe(id);
      expect(o.provenance.tables.length).toBeGreaterThan(0);
      expect(["complete", "partial", "unavailable"]).toContain(o.coverage.state);
      if (o.outcome === "OK") {
        expect(o.table.columns.length).toBeGreaterThan(0);
        // the window end is pinned to an absolute day, so the hash names one computation
        expect((o.call.input as Record<string, unknown>).to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    },
    90_000,
  );

  it("a source that cannot answer is the typed CANNOT_COMPUTE outcome through the gateway", async () => {
    const r = await call("intents.analyze@1", { analysis: "solver_metrics", days: 7 });
    expect(r.state).toBe("ok");
    const { ok: _ok, ...rest } = r.payload as Record<string, unknown>;
    void _ok;
    const o = AnalyticsOutcome.parse(rest);
    expect(o.outcome).toBe("CANNOT_COMPUTE");
    if (o.outcome === "CANNOT_COMPUTE") {
      expect(o.missing.join(" ")).toMatch(/solver/i);
      expect(o.explanation.length).toBeGreaterThan(20);
    }
  }, 60_000);

  it("a run on the fixture source never gets live numbers: typed CANNOT_COMPUTE", async () => {
    const r = await call("accounts.analyze@1", SAMPLE["accounts.analyze@1"], fixtureRun);
    expect(r.state).toBe("ok");
    const { ok: _ok, ...rest } = r.payload as Record<string, unknown>;
    void _ok;
    const o = AnalyticsOutcome.parse(rest);
    expect(o).toMatchObject({ outcome: "CANNOT_COMPUTE", missing: ["live data source for this run"] });
  });

  it("the kernel rejects unknown analyses, SQL-like keys, client-supplied tenancy and oversized windows", async () => {
    for (const bad of [
      { analysis: "raw_sql", sql: "select 1" },
      { analysis: "status", tenantId: "x" },
      { analysis: "status", days: 100000 },
      { analysis: "refund_rates", top: 100000 },
    ]) {
      const r = await call("intents.analyze@1", bad);
      expect(r.state).not.toBe("ok");
      expect(r.reasonCode).toBe("INPUT_SCHEMA_INVALID");
    }
  });
});
