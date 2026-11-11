import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CapsuleResponseRecord } from "@nearesis/contracts";
import { buildCapsule } from "../../../packages/capsule/src/index.ts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

let f: ApiFixture;
let token: string;
let id: string;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "api-capsules-"));
  process.env.NEARESIS_CAPSULE_DIR = dir;
  const m = buildCapsule({
    snapshotDir: join(import.meta.dirname, "../../../packages/capsule/fixtures/snapshot-synthetic"),
    outDir: join(dir, "cap-synthetic-2026-11-10"),
  });
  id = m.capsuleId;
  f = await apiFixture();
  const org = await seedOrg(f.db.admin, "acme", { alice: "owner" });
  token = await login(f.app, org.users.alice!.subject);
});
afterAll(async () => {
  delete process.env.NEARESIS_CAPSULE_DIR;
  await f?.close();
});

it("requires a session", async () => {
  expect((await f.app.inject({ method: "GET", url: `/v1/capsules/${id}` })).statusCode).toBe(401);
});

it("serves the viewer record with local and OutLayer kept apart", async () => {
  const r = await f.app.inject({ method: "GET", url: `/v1/capsules/${id}`, headers: bearer(token) });
  expect(r.statusCode).toBe(200);
  const body = CapsuleResponseRecord.parse(r.json());
  if (body.status !== "available") throw new Error("expected available");
  expect(body.capsule.verification.local.status).toBe("reproduced");
  expect(body.capsule.verification.outlayer.status).toBe("not_submitted");
  expect(body.capsule.sourceLabel).toBe("SYNTHETIC");
  const list = await f.app.inject({ method: "GET", url: "/v1/capsules", headers: bearer(token) });
  expect(list.json()).toMatchObject({ capsules: [{ capsuleId: id }] });
});

it("unknown and malformed ids are indistinguishable and never leak paths", async () => {
  for (const u of ["/v1/capsules/nope", "/v1/capsules/..%2F..%2Fetc", "/v1/capsules/.hidden"]) {
    const r = await f.app.inject({ method: "GET", url: u, headers: bearer(token) });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { status: string }).status).toBe("unavailable");
  }
});

it("serves only manifest-listed exports, with the manifest hash and a locked-down CSP", async () => {
  const r = await f.app.inject({
    method: "GET",
    url: `/v1/capsules/${id}/exports/site/index.html`,
    headers: bearer(token),
  });
  expect(r.statusCode).toBe(200);
  expect(r.headers["content-type"]).toContain("text/html");
  expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
  expect(r.headers["x-capsule-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  for (const u of [
    "exports/../manifest.json",
    "exports/..%2Fmanifest.json",
    "exports/nothing.md",
    "exports/%2e%2e/manifest.json",
  ]) {
    const x = await f.app.inject({ method: "GET", url: `/v1/capsules/${id}/${u}`, headers: bearer(token) });
    expect(x.statusCode).toBe(404);
  }
  expect(
    (
      await f.app.inject({
        method: "GET",
        url: `/v1/capsules/${id}/exports/THESIS.md`,
        headers: bearer(token),
      })
    ).statusCode,
  ).toBe(200);
});

it("a tampered raw byte shows as mismatch/unverified in the record", async () => {
  const dir = process.env.NEARESIS_CAPSULE_DIR!;
  const raw = join(dir, id, "snapshot", "raw", "daily_series.csv");
  writeFileSync(raw, "date,intents_volume_usd_cents,active_signers\n2026-08-13,1,1\n");
  const r = await f.app.inject({ method: "GET", url: `/v1/capsules/${id}`, headers: bearer(token) });
  const body = CapsuleResponseRecord.parse(r.json());
  if (body.status !== "available") throw new Error("expected available");
  expect(body.capsule.verification.local.status).toBe("mismatch");
  expect(body.capsule.verification.failures.map((x) => x.kind)).toContain("RAW_HASH_MISMATCH");
});
