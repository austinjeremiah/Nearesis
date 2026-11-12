import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCapsule, writeCapsuleOwnership } from "../../../packages/capsule/src/index.ts";
import {
  AGENT,
  principal,
  setup,
  txPerDay,
  type Harness,
} from "../../../packages/semantic-gateway/test/authoring/harness.ts";
import { pinHistorySnapshot } from "../src/metric-publish-guard.ts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

const FIXTURE = join(import.meta.dirname, "../../..", "packages/capsule/fixtures/snapshot-synthetic");

let h: Harness;
let f: ApiFixture;
let capsules: string;
let published: string;
let alice: string;
let orgId: string;
let wsId: string;
let author: ReturnType<typeof principal>;
let owner: ReturnType<typeof principal>;
const cid = (n: string) => `cap-guard-${n}`;

const post = async (url: string, payload: Record<string, unknown>) => {
  const r = await f.app.inject({ method: "POST", url, headers: bearer(alice), payload });
  return { status: r.statusCode, body: r.json() as Record<string, unknown> };
};
/** A capsule built under `{ key: "<version>.0.0" }`; the major component is the authored integer version. */
function capsule(name: string, metricKey: string, version: number): string {
  const id = cid(name);
  buildCapsule({
    snapshotDir: FIXTURE,
    outDir: join(capsules, id),
    capsuleId: id,
    metricVersions: { [metricKey]: `${version}.0.0` },
  });
  writeCapsuleOwnership(join(capsules, id), { orgId, workspaceId: wsId });
  return id;
}
async function metric(name: string, upTo: "VALIDATED" | "CERTIFIED" | "DEPRECATED") {
  const d = await h.svc.propose(author, txPerDay(author, { name }));
  expect(d.record.status).toBe("VALIDATED");
  if (upTo !== "VALIDATED") await h.svc.certify(owner, d.record.metricKey, d.record.version);
  if (upTo === "DEPRECATED")
    await h.svc.deprecate(owner, d.record.metricKey, d.record.version, "definition double counted retries");
  return d.record;
}

beforeAll(async () => {
  h = await setup();
  capsules = mkdtempSync(join(tmpdir(), "guard-caps-"));
  published = mkdtempSync(join(tmpdir(), "guard-out-"));
  process.env.NEARESIS_CAPSULE_DIR = capsules;
  process.env.NEARESIS_PUBLISH_DIR = published;
  f = await apiFixture({ appOptions: { authoring: h.svc } });
  const org = await seedOrg(f.db.admin, "guard-a", { alice: "owner" });
  orgId = org.orgId;
  alice = await login(f.app, org.users.alice!.subject);
  const r = await f.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...bearer(alice), "idempotency-key": "guard-route-ws-0001" },
    payload: { objective: "guard", networkScope: "fixture-only" },
  });
  wsId = (r.json() as { workspaceId: string }).workspaceId;
  author = { ...AGENT, tenantId: orgId, workspaceId: wsId };
  owner = { ...principal("owner-1", "human", "owner"), tenantId: orgId, workspaceId: wsId };
}, 180_000);
afterAll(async () => {
  for (const k of ["NEARESIS_CAPSULE_DIR", "NEARESIS_PUBLISH_DIR"]) delete process.env[k];
  await f?.close();
  await h?.close();
  rmSync(capsules, { recursive: true, force: true });
  rmSync(published, { recursive: true, force: true });
});

describe("capsule publication refuses non-certified semantic metrics (assertPublishable)", () => {
  it("DRAFT/VALIDATED, DEPRECATED and unknown metrics block POST /v1/publish and /v1/capsules/:id/publish with 422 METRIC_NOT_CERTIFIED", async () => {
    const v = await metric("guard_validated", "VALIDATED");
    const d = await metric("guard_deprecated", "DEPRECATED");
    for (const [n, key, ver] of [
      ["val", v.metricKey, v.version],
      ["dep", d.metricKey, d.version],
      ["unk", "authored.never_proposed", 1],
    ] as const) {
      const id = capsule(n, key, ver);
      const a = await post("/v1/publish", { capsuleId: id });
      expect(a.status).toBe(422);
      expect(a.body).toMatchObject({ reasonCode: "METRIC_NOT_CERTIFIED" });
      expect(JSON.stringify(a.body)).toContain(key);
      const b = await post(`/v1/capsules/${id}/publish`, {});
      expect(b.status).toBe(422);
      expect(b.body).toMatchObject({ reasonCode: "METRIC_NOT_CERTIFIED" });
    }
    const au = await f.db.admin.query<{ n: string }>(
      "SELECT count(*)::text n FROM audit_events WHERE reason_code='METRIC_NOT_CERTIFIED'",
    );
    expect(Number(au.rows[0]!.n)).toBeGreaterThanOrEqual(6);
    // nothing was exported and nothing pinned
    expect(await h.svc.pinsOf(owner, `capsule:${cid("val")}`)).toEqual([]);
  });

  it("a capsule built only on CERTIFIED metrics still publishes, and the exact version is pinned", async () => {
    const c = await metric("guard_certified", "CERTIFIED");
    const id = capsule("ok", c.metricKey, c.version);
    const r = await post("/v1/publish", { capsuleId: id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ capsuleId: id, signature: "unsigned" });
    const pins = await h.svc.pinsOf(owner, `capsule:${id}`);
    expect(pins).toEqual([expect.objectContaining({ metricKey: c.metricKey, version: c.version })]);
    const m = await post(`/v1/capsules/${id}/publish`, {});
    expect(m.status).toBe(200);
  });

  it("a capsule without semantic metric keys (research labels like `m`) is unaffected", async () => {
    const id = cid("plain");
    buildCapsule({
      snapshotDir: FIXTURE,
      outDir: join(capsules, id),
      capsuleId: id,
      metricVersions: { m: "1.0.0" },
    });
    writeCapsuleOwnership(join(capsules, id), { orgId, workspaceId: wsId });
    expect((await post("/v1/publish", { capsuleId: id })).status).toBe(200);
  });
});

describe("pinHistorySnapshot pins certified versions only", () => {
  it("pins CERTIFIED authored versions of a snapshot's semanticPins; drafts, registry metrics and junk stay unpinned", async () => {
    const c = await metric("pin_certified", "CERTIFIED");
    const dr = await metric("pin_draft", "VALIDATED");
    const n = await pinHistorySnapshot(h.svc, owner, "snap-h-1", {
      [c.metricKey]: `${c.version}.0.0`,
      [dr.metricKey]: `${dr.version}.0.0`,
      "live.oneclick_volume_usd_known": "1.0.0",
      junk: "x",
    });
    expect(n).toBe(1);
    const pins = await h.svc.pinsOf(owner, "snap-h-1");
    expect(pins.map((p) => p.metricKey)).toEqual([c.metricKey]);
    expect(await pinHistorySnapshot(undefined, owner, "snap-h-2", { [c.metricKey]: "1.0.0" })).toBe(0);
  });
});
