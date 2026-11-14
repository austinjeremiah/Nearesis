import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCapsule,
  isCapsulePublic,
  readCapsulePublicationState,
  writeCapsuleOwnership,
} from "../../../packages/capsule/src/index.ts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../../..");
const SNAPSHOT = join(ROOT, "packages/capsule/fixtures/snapshot-synthetic");

let f: ApiFixture;
let dir: string;
let alice: string;
let viewer: string;
let bob: string;
let orgAId: string;
const ids = { clean: "cap-pub-clean", tampered: "cap-pub-tampered", foreign: "cap-pub-foreign" };

async function workspace(tok: string, key: string): Promise<string> {
  const r = await f.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...bearer(tok), "idempotency-key": key },
    payload: { objective: "publication", networkScope: "fixture-only" },
  });
  return (r.json() as { workspaceId: string }).workspaceId;
}
const post = async (tok: string, url: string, payload?: unknown) => {
  const r = await f.app.inject({
    method: "POST",
    url,
    headers: bearer(tok),
    ...(payload ? { payload } : {}),
  });
  return { status: r.statusCode, body: r.json() as Record<string, unknown> };
};
const audits = async (action: string, subject: string) =>
  (
    await f.db.admin.query<{ outcome: string; reason_code: string | null }>(
      "SELECT outcome, reason_code FROM audit_events WHERE action = $1 AND subject = $2 ORDER BY occurred_at",
      [action, `capsule:${subject}`],
    )
  ).rows;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "api-capsule-pub-"));
  process.env.NEARESIS_CAPSULE_DIR = dir;
  f = await apiFixture();
  const orgA = await seedOrg(f.db.admin, "pub-a", { alice: "owner", vic: "viewer" });
  const orgB = await seedOrg(f.db.admin, "pub-b", { bob: "owner" });
  orgAId = orgA.orgId;
  alice = await login(f.app, orgA.users.alice!.subject);
  viewer = await login(f.app, orgA.users.vic!.subject);
  bob = await login(f.app, orgB.users.bob!.subject);
  const wsA = await workspace(alice, "capsule-pub-a-0001");
  const wsB = await workspace(bob, "capsule-pub-b-0001");
  mkdirSync(dir, { recursive: true });
  for (const id of Object.values(ids)) buildCapsule({ snapshotDir: SNAPSHOT, outDir: join(dir, id) });
  writeCapsuleOwnership(join(dir, ids.clean), { orgId: orgA.orgId, workspaceId: wsA });
  writeCapsuleOwnership(join(dir, ids.tampered), { orgId: orgA.orgId, workspaceId: wsA });
  writeCapsuleOwnership(join(dir, ids.foreign), { orgId: orgB.orgId, workspaceId: wsB });
}, 120_000);
afterAll(async () => {
  delete process.env.NEARESIS_CAPSULE_DIR;
  await f?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("capsule publication", () => {
  it("is private by default; publishing needs a writer, is audited, and unpublish withdraws it", async () => {
    const d = join(dir, ids.clean);
    expect(isCapsulePublic(d)).toBe(false);
    const denied = await post(viewer, `/v1/capsules/${ids.clean}/publish`);
    expect(denied.status).toBe(403);
    expect(isCapsulePublic(d)).toBe(false);
    const ok = await post(alice, `/v1/capsules/${ids.clean}/publish`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: "published", badge: { label: "unverified" } });
    expect(isCapsulePublic(d)).toBe(true);
    expect(readCapsulePublicationState(d)).toMatchObject({ state: "published", orgId: orgAId });
    const un = await post(alice, `/v1/capsules/${ids.clean}/unpublish`);
    expect(un.body).toMatchObject({ state: "unpublished" });
    expect(isCapsulePublic(d)).toBe(false);
    expect(
      (await audits("capsule.publish", ids.clean)).map((a) => `${a.outcome}:${a.reason_code ?? ""}`),
    ).toEqual(["denied:ROLE_CANNOT_PUBLISH", "ok:"]);
    expect((await audits("capsule.unpublish", ids.clean)).map((a) => a.outcome)).toEqual(["ok"]);
  });

  it("another tenant cannot publish, unpublish or see the publication of a capsule (404, no change)", async () => {
    const d = join(dir, ids.clean);
    for (const url of ["publish", "unpublish"]) {
      const r = await post(bob, `/v1/capsules/${ids.clean}/${url}`);
      expect(r.status).toBe(404);
    }
    expect(isCapsulePublic(d)).toBe(false);
    const g = await f.app.inject({
      method: "GET",
      url: `/v1/capsules/${ids.clean}/publication`,
      headers: bearer(bob),
    });
    expect(g.statusCode).toBe(404);
    // and the foreign capsule is equally out of reach for alice
    expect((await post(alice, `/v1/capsules/${ids.foreign}/publish`)).status).toBe(404);
    expect(isCapsulePublic(join(dir, ids.foreign))).toBe(false);
  });

  it("a capsule that fails local verification is published only with an explicit acknowledgement", async () => {
    const mf = join(dir, ids.tampered, "snapshot", "raw", "daily_series.csv");
    writeFileSync(mf, "date,a\n");
    const d = join(dir, ids.tampered);
    const refused = await post(alice, `/v1/capsules/${ids.tampered}/publish`);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ reasonCode: "ACKNOWLEDGEMENT_REQUIRED" });
    expect(isCapsulePublic(d)).toBe(false);
    const wrong = await post(alice, `/v1/capsules/${ids.tampered}/publish`, {
      acknowledge: ["SOMETHING_ELSE"],
    });
    expect(wrong.status).toBe(422);
    const ok = await post(alice, `/v1/capsules/${ids.tampered}/publish`, {
      acknowledge: ["VERIFICATION_FAILED"],
    });
    expect(ok.status).toBe(200);
    expect(readCapsulePublicationState(d)?.acknowledged).toEqual(["VERIFICATION_FAILED"]);
    expect((await audits("capsule.publish", ids.tampered)).map((a) => a.reason_code ?? "ok")).toEqual([
      "ACKNOWLEDGEMENT_REQUIRED",
      "ACKNOWLEDGEMENT_REQUIRED",
      "ok",
    ]);
  });
});
