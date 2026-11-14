import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addTrustedKey,
  buildCapsule,
  fingerprintOf,
  newChallenge,
  revokeTrustedKey,
  signChallenge,
  writeCapsuleOwnership,
} from "../../../packages/capsule/src/index.ts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

const FIXTURE = join(import.meta.dirname, "../../../packages/capsule/fixtures/snapshot-synthetic");
const ID = "cap-by-manifest-id";
const DIRNAME = "dir-name-differs";

let f: ApiFixture;
let capsules: string;
let published: string;
let registry: string;
let alice: string;
let bob: string;
let fingerprint: string;
const COMMIT = {
  network: "testnet",
  contract: "commit.test.testnet",
  txHash: "TXHASH1",
  viewTimestampNs: "1794517503152963705",
  // gas the fake anchor burnt; converted to USD and charged from the publisher's credits
  spentYocto: "1000000000000000000000",
};
let readbackEqual = true;
const get = (tok: string | null, url: string) =>
  f.app.inject({ method: "GET", url, headers: tok ? bearer(tok) : {} });
const post = (tok: string, url: string, payload: unknown = {}) =>
  f.app.inject({ method: "POST", url, headers: bearer(tok), payload: payload as object });

beforeAll(async () => {
  capsules = mkdtempSync(join(tmpdir(), "ct-caps-"));
  published = mkdtempSync(join(tmpdir(), "ct-out-"));
  registry = join(published, "trusted.json");
  const kp = generateKeyPairSync("ed25519");
  const pem = kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keyFile = join(published, "key.pem");
  writeFileSync(keyFile, pem, { mode: 0o600 });
  const ch = newChallenge();
  addTrustedKey(registry, {
    publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }).toString(),
    challenge: ch,
    signature: signChallenge(ch, kp.privateKey),
  });
  fingerprint = fingerprintOf(kp.publicKey);
  Object.assign(process.env, {
    NEARESIS_CAPSULE_DIR: capsules,
    NEARESIS_PUBLISH_DIR: published,
    NEARESIS_PUBLISH_KEY_FILE: keyFile,
    NEARESIS_ALLOW_PLAIN_PUBLISH_KEY: "1",
    NEARESIS_TRUSTED_KEYS_FILE: registry,
  });
  f = await apiFixture({
    appOptions: {
      nearUsdRate: async () => ({ rate: "3.5", date: "2026-11-13" }),
      publishAnchorChain: async () => COMMIT,
      chainReadback: async (_tx, hash) => ({
        finality: "FINAL",
        succeeded: true,
        receiver: COMMIT.contract,
        argsHash: readbackEqual ? hash : "0".repeat(64),
        viewPresent: true,
        viewTimestampNs: COMMIT.viewTimestampNs,
        equal: readbackEqual,
      }),
    },
  });
  const a = await seedOrg(f.db.admin, "ct-a", { alice: "owner" });
  const b = await seedOrg(f.db.admin, "ct-b", { bob: "owner" });
  // the testnet anchor gas is paid from the publisher's USD credits (the allowance is granted on first use)
  alice = await login(f.app, a.users.alice!.subject);
  bob = await login(f.app, b.users.bob!.subject);
  const ws = (
    await post(alice, "/v1/workspaces", {
      objective: "o",
      networkScope: "fixture-only",
      idempotencyKey: "ct-ws-00000001",
    })
  ).json<{ workspaceId: string }>().workspaceId;
  mkdirSync(capsules, { recursive: true });
  // directory name differs from the manifest capsuleId
  buildCapsule({ snapshotDir: FIXTURE, outDir: join(capsules, DIRNAME), capsuleId: ID });
  writeCapsuleOwnership(join(capsules, DIRNAME), { orgId: a.orgId, workspaceId: ws });
}, 120_000);
afterAll(async () => {
  for (const k of [
    "NEARESIS_CAPSULE_DIR",
    "NEARESIS_PUBLISH_DIR",
    "NEARESIS_PUBLISH_KEY_FILE",
    "NEARESIS_ALLOW_PLAIN_PUBLISH_KEY",
    "NEARESIS_TRUSTED_KEYS_FILE",
  ])
    delete process.env[k];
  await f?.close();
  rmSync(capsules, { recursive: true, force: true });
  rmSync(published, { recursive: true, force: true });
});

describe("capsule id resolution", () => {
  it("resolves by the manifest capsuleId on every route, with the directory name as a fallback", async () => {
    const byId = await get(alice, `/v1/capsules/${ID}`);
    expect(byId.json()).toMatchObject({ status: "available", capsule: { capsuleId: ID } });
    expect((await get(alice, `/v1/capsules/${DIRNAME}`)).json()).toMatchObject({ status: "available" });
    expect((await get(alice, `/v1/capsules/${ID}/publication`)).statusCode).toBe(200);
    expect((await get(alice, `/v1/capsules/${ID}/verify`)).statusCode).toBe(200);
    expect((await get(bob, `/v1/capsules/${ID}`)).json()).toMatchObject({ status: "unavailable" });
  });
});

describe("publish, key trust and anchors", () => {
  let manifestHash = "";
  it("POST /v1/publish by manifest id returns key fingerprint, trust, hardened flag and anchor details", async () => {
    const r = await post(alice, "/v1/publish", { capsuleId: ID });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    manifestHash = b.manifestHash;
    expect(b).toMatchObject({ capsuleId: ID, hardened: false, signingSource: "plain-file" });
    expect(b.signingKey).toMatchObject({
      fingerprint,
      keyStatus: "active",
      trusted: true,
      revokedAt: null,
    });
    expect(b.anchor).toMatchObject({ log: "appended", chain: "committed" });
    expect(b.anchor.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.anchor.testnet).toMatchObject({
      network: "testnet",
      txHash: "TXHASH1",
      readback: "verified_at_commit",
    });
    // published under the manifest id, not the directory name
    expect(
      (
        await f.db.admin.query("SELECT count(*)::int n FROM publication_anchor_log WHERE manifest_hash=$1", [
          manifestHash,
        ])
      ).rows[0].n,
    ).toBe(2);
  });
  it("verify route lists the publication with key status and anchors", async () => {
    const v = (await get(alice, `/v1/capsules/${ID}/verify`)).json();
    expect(v.latestPublication).toMatchObject({
      manifestHash,
      key: { fingerprint, keyStatus: "active", trusted: true },
      anchor: { log: { seq: expect.any(Number) }, chain: { txHash: "TXHASH1" } },
    });
  });
  it("anchor readback route verifies the testnet commitment, reports mismatch, and is tenant scoped", async () => {
    expect((await get(alice, `/v1/capsules/${ID}/anchor`)).json()).toMatchObject({
      status: "verified",
      manifestHash,
      readback: { finality: "FINAL", equal: true, committedHash: manifestHash, contract: COMMIT.contract },
    });
    readbackEqual = false;
    expect((await get(alice, `/v1/capsules/${ID}/anchor?manifestHash=${manifestHash}`)).json()).toMatchObject(
      { status: "mismatch" },
    );
    readbackEqual = true;
    expect((await get(alice, `/v1/capsules/${ID}/anchor?manifestHash=${"a".repeat(64)}`)).statusCode).toBe(
      404,
    );
    expect((await get(alice, `/v1/capsules/${ID}/anchor?manifestHash=zz`)).statusCode).toBe(422);
    expect((await get(bob, `/v1/capsules/${ID}/anchor`)).statusCode).toBe(404);
    expect((await get(null, `/v1/capsules/${ID}/anchor`)).statusCode).toBe(401);
  });
  it("a revoked key shows as revoked and untrusted unless anchored before the revocation", async () => {
    revokeTrustedKey(registry, fingerprint, "test revocation");
    const v = (await get(alice, `/v1/capsules/${ID}/verify`)).json();
    expect(v.latestPublication.key).toMatchObject({ keyStatus: "revoked", revokedAt: expect.any(String) });
    // anchored (log time) before the revocation and signed before it: still trusted, with the reason stated
    expect(v.latestPublication.key.trustReason).toMatch(/before the key was revoked/);
  });
});

describe("GET /v1/public/publications/:id", () => {
  it("serves nothing until explicitly published, then a tenant-free public view, then 404 withdrawn", async () => {
    expect((await get(null, `/v1/public/publications/${ID}`)).json()).toMatchObject({
      reasonCode: "PUBLICATION_NOT_FOUND",
    });
    expect((await get(null, `/v1/public/publications/nope`)).statusCode).toBe(404);
    const pub = await post(alice, `/v1/capsules/${ID}/publish`, {
      acknowledge: [
        "VERIFICATION_FAILED",
        "VERIFIED_STATE_FAILED",
        "INSUFFICIENT_DATA",
        "METHOD_NOT_VALIDATED",
        "NOT_REPRODUCIBLE",
      ],
    });
    expect(pub.statusCode, pub.body).toBe(200);
    const r = await get(null, `/v1/public/publications/${ID}`);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ capsuleId: ID, state: "published" });
    expect(b.versions[0]).toMatchObject({ key: { fingerprint }, anchor: { chain: { txHash: "TXHASH1" } } });
    expect(JSON.stringify(b)).not.toMatch(/orgId|workspaceId|actorId/);
    expect(b.hashes.sourceSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await post(alice, `/v1/capsules/${ID}/unpublish`)).statusCode).toBe(200);
    const w = await get(null, `/v1/public/publications/${ID}`);
    expect(w.statusCode).toBe(404);
    expect(w.json()).toMatchObject({ reasonCode: "PUBLICATION_WITHDRAWN" });
  });
  it("is rate limited per client", async () => {
    let limited = 0;
    for (let i = 0; i < 70; i++)
      if ((await get(null, `/v1/public/publications/x${i}`)).statusCode === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});
