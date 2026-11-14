import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCapsule,
  buildLiveCapsuleInput,
  appendPublishAnchor,
  isCapsulePublic,
  readAnchorLog,
  verifyAnchorChain,
  verifyPublishManifest,
  writeCapsuleOwnership,
} from "../../../packages/capsule/src/index.ts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../../..");
const LIVE_ID = "live-20260603-20261111-live-organic-v2-15fe2ad62d6c";
const LIVE_SNAPSHOT = join(ROOT, "docs/research/live-snapshots", LIVE_ID);
const LIVE_RESULTS = join(ROOT, "docs/research/live-results", LIVE_ID);
const FIXTURE = join(ROOT, "packages/capsule/fixtures/snapshot-synthetic");

let f: ApiFixture;
let capsules: string;
let published: string;
let alice: string;
let viewer: string;
let bob: string;
let wsA: string;
const ids = { live: "cap-live-publish", fixture: "cap-fixture-publish" };
const post = async (tok: string, payload: Record<string, unknown>) => {
  const r = await f.app.inject({ method: "POST", url: "/v1/publish", headers: bearer(tok), payload });
  return { status: r.statusCode, body: r.json() as Record<string, unknown> };
};

beforeAll(async () => {
  capsules = mkdtempSync(join(tmpdir(), "api-pub-caps-"));
  published = mkdtempSync(join(tmpdir(), "api-pub-out-"));
  process.env.NEARESIS_CAPSULE_DIR = capsules;
  process.env.NEARESIS_PUBLISH_DIR = published;
  const keyFile = join(published, "key.pem");
  writeFileSync(
    keyFile,
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    { mode: 0o600 },
  );
  process.env.NEARESIS_PUBLISH_KEY_FILE = keyFile;
  process.env.NEARESIS_ALLOW_PLAIN_PUBLISH_KEY = "1";
  f = await apiFixture();
  const orgA = await seedOrg(f.db.admin, "pubroute-a", { alice: "owner", vic: "viewer" });
  const orgB = await seedOrg(f.db.admin, "pubroute-b", { bob: "owner" });
  alice = await login(f.app, orgA.users.alice!.subject);
  viewer = await login(f.app, orgA.users.vic!.subject);
  bob = await login(f.app, orgB.users.bob!.subject);
  const r = await f.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...bearer(alice), "idempotency-key": "publish-route-ws-0001" },
    payload: { objective: "publish", networkScope: "fixture-only" },
  });
  wsA = (r.json() as { workspaceId: string }).workspaceId;
  const input = join(published, "live-input");
  buildLiveCapsuleInput({ liveSnapshotDir: LIVE_SNAPSHOT, outDir: input, analysisCodeCommit: "3b5c4fd" });
  mkdirSync(capsules, { recursive: true });
  buildCapsule({
    snapshotDir: input,
    outDir: join(capsules, ids.live),
    capsuleId: ids.live,
    researchBundleDir: LIVE_RESULTS,
  });
  buildCapsule({ snapshotDir: FIXTURE, outDir: join(capsules, ids.fixture) });
  for (const id of Object.values(ids))
    writeCapsuleOwnership(join(capsules, id), { orgId: orgA.orgId, workspaceId: wsA });
}, 120_000);
afterAll(async () => {
  for (const k of [
    "NEARESIS_CAPSULE_DIR",
    "NEARESIS_PUBLISH_DIR",
    "NEARESIS_PUBLISH_KEY_FILE",
    "NEARESIS_ALLOW_PLAIN_PUBLISH_KEY",
    "NEARESIS_PUBLISH_KEY_ENCRYPTED_FILE",
    "NEARESIS_PUBLISH_KEY_PASSPHRASE",
  ])
    delete process.env[k];
  await f?.close();
  rmSync(capsules, { recursive: true, force: true });
  rmSync(published, { recursive: true, force: true });
});

describe("POST /v1/publish", () => {
  it("refuses viewers and other tenants, and needs the caution acknowledged", async () => {
    expect((await post(viewer, { capsuleId: ids.fixture })).status).toBe(403);
    expect((await post(bob, { capsuleId: ids.fixture })).status).toBe(404);
    expect((await post(alice, { capsuleId: "../etc" })).status).toBe(404);
    const refused = await post(alice, { capsuleId: ids.live });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ reasonCode: "ACKNOWLEDGEMENT_REQUIRED" });
  });

  it("exports the live capsule bundle with a verified signed manifest and emits research.published + publication.ready.v1", async () => {
    const before = (
      await f.db.admin.query<{ n: string }>(
        "SELECT count(*)::text n FROM workspace_events WHERE workspace_id=$1 AND event_type='research.published'",
        [wsA],
      )
    ).rows[0]!.n;
    expect(before).toBe("0");
    const ok = await post(alice, { capsuleId: ids.live, acknowledge: ["INSUFFICIENT_DATA"] });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ capsuleId: ids.live, label: "LIVE", signature: "valid", created: true });
    expect(ok.body.topics).toEqual(["research.published", "publication.ready.v1"]);
    const version = ok.body.version as string;
    const dir = join(published, ids.live, version);
    const v = verifyPublishManifest(dir, `${dir}.publish-manifest.json`);
    expect(v.problems).toEqual([]);
    expect(
      (JSON.parse(readFileSync(`${dir}.publish-manifest.json`, "utf8")) as { manifestHash: string })
        .manifestHash,
    ).toBe(ok.body.manifestHash);
    // journal and outbox: one event, two topics, same transaction
    const ev = await f.db.admin.query<{ event_id: string; payload: { manifestHash: string } }>(
      "SELECT event_id, payload FROM workspace_events WHERE workspace_id=$1 AND event_type='research.published'",
      [wsA],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.payload.manifestHash).toBe(ok.body.manifestHash);
    const topics = await f.db.admin.query<{ topic: string }>(
      "SELECT topic FROM outbox WHERE event_id=$1 ORDER BY topic",
      [ev.rows[0]!.event_id],
    );
    expect(topics.rows.map((t) => t.topic)).toEqual(["publication.ready.v1", "workspace.entity.changed.v1"]);
    // an audited export, and public MCP visibility is untouched
    const au = await f.db.admin.query<{ outcome: string }>(
      "SELECT outcome FROM audit_events WHERE action='publication.export' AND subject=$1 AND outcome='ok'",
      [`capsule:${ids.live}`],
    );
    expect(au.rows).toHaveLength(1);
    expect(isCapsulePublic(join(capsules, ids.live))).toBe(false);
    // repeating the request is idempotent (same version, same manifest)
    const again = await post(alice, { capsuleId: ids.live, acknowledge: ["INSUFFICIENT_DATA"] });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, manifestHash: ok.body.manifestHash });
  });

  it("exports a fixture capsule too, labelled SYNTHETIC", async () => {
    const ok = await post(alice, { capsuleId: ids.fixture });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ label: "SYNTHETIC", signature: "valid" });
  });

  it("plaintext key: refused without the dev flag; with it the response and log say hardened:false", async () => {
    delete process.env.NEARESIS_ALLOW_PLAIN_PUBLISH_KEY;
    const refused = await post(alice, { capsuleId: ids.fixture });
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ reasonCode: "PLAINTEXT_PUBLISH_KEY_REFUSED" });
    process.env.NEARESIS_ALLOW_PLAIN_PUBLISH_KEY = "1";
    const ok = await post(alice, { capsuleId: ids.fixture });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ hardened: false, signingSource: "plain-file" });
  });

  it("encrypted key is a hardened source; the publication is appended to the hash-chained log", async () => {
    const enc = join(published, "enc.pem");
    writeFileSync(
      enc,
      generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "pw-for-test" })
        .toString(),
    );
    process.env.NEARESIS_PUBLISH_KEY_ENCRYPTED_FILE = enc;
    process.env.NEARESIS_PUBLISH_KEY_PASSPHRASE = "pw-for-test";
    try {
      const ok = await post(alice, { capsuleId: ids.fixture });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ hardened: true, signingSource: "encrypted-file", signature: "valid" });
      const rows = (await f.db.admin.query("SELECT * FROM publication_anchor_log ORDER BY seq")).rows;
      const entries = await readAnchorLog(f.db.admin);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(verifyAnchorChain(entries)).toEqual([]);
      const mine = entries.find((e) => e.manifestHash === ok.body.manifestHash)!;
      expect(mine.kind).toBe("publish");
      expect(mine.signedAt).toMatch(/Z$/);
      // an independent database timestamp exists and is not the signer's
      expect(Date.parse(mine.anchoredAt)).toBeGreaterThan(0);
    } finally {
      delete process.env.NEARESIS_PUBLISH_KEY_ENCRYPTED_FILE;
      delete process.env.NEARESIS_PUBLISH_KEY_PASSPHRASE;
    }
  });

  it("the log is append-only: update, delete and truncate are refused; a client cannot choose seq or hash", async () => {
    await expect(f.db.admin.query("UPDATE publication_anchor_log SET payload = 'x'")).rejects.toThrow(
      /append-only/,
    );
    await expect(f.db.admin.query("DELETE FROM publication_anchor_log")).rejects.toThrow(/append-only/);
    await expect(f.db.admin.query("TRUNCATE publication_anchor_log")).rejects.toThrow(/append-only/);
    const forged = await appendPublishAnchor(f.db.admin, {
      manifestHash: "a".repeat(64),
      signedAt: "2020-01-01T00:00:00.000Z",
      capsuleId: "forge",
      version: "v",
      keyFingerprint: null,
    });
    // the claimed (backdated) signing time is recorded as claimed; the log time is the database clock
    expect(forged.signedAt).toBe("2020-01-01T00:00:00.000Z");
    expect(Date.parse(forged.anchoredAt)).toBeGreaterThan(Date.parse("2026-01-01"));
    expect(verifyAnchorChain(await readAnchorLog(f.db.admin))).toEqual([]);
  });

  it("without a configured chain hook the response reports anchor.chain not_configured (log entry still written)", async () => {
    const ok = await post(alice, { capsuleId: ids.live, acknowledge: ["INSUFFICIENT_DATA"] });
    expect(ok.status).toBe(200);
    expect(ok.body.anchor).toMatchObject({ chain: "not_configured" });
  });
});
