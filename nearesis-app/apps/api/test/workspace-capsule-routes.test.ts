import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnalyticsPanelData } from "@nearesis/contracts";
import { CreditsService } from "@nearesis/kernel";
import {
  addTrustedKey,
  buildCapsule,
  newChallenge,
  signChallenge,
  writeCapsuleOwnership,
} from "../../../packages/capsule/src/index.ts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import type { PanelDataPort, StoredQuery } from "../src/panel-data.ts";

const H_A = "a".repeat(64);
const H_B = "b".repeat(64);
const H_ONE = "c".repeat(64);
const day = (i: number): string =>
  new Date(Date.parse("2026-10-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);

const body = (hash: string, columns: string[], rows: unknown[][]): AnalyticsPanelData =>
  ({
    chart: {
      queryHash: hash,
      dataRevision: 1,
      columns: columns.map((name) => ({ name, unit: name === "period" ? null : "unit" })),
      rows,
      downsampling: { method: "none", originalPoints: rows.length },
      freshness: "fresh",
      sourceWatermark: "2026-11-12",
    },
    shape: {
      queryHash: hash,
      fields: columns.map((name, i) => ({ name, unit: null, role: i === 0 ? "time" : "measure" })),
    },
    provenance: {
      queryHash: hash,
      sourceLabel: "ANALYTICS",
      certification: "SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC",
      capability: "intents.analyze@1",
      analysis: "trend",
      call: { capability: "intents.analyze@1", input: { analysis: "trend" } },
      resultHash: "c".repeat(64),
      sources: ["nearesis_live.intents_swaps"],
      metricVersion: "intents-1.0.0",
      definition: "d",
      method: "m",
      asOf: "2026-11-12",
      computedAt: "2026-11-13T00:00:00.000Z",
      coverage: {
        state: "complete",
        daysRequested: 12,
        daysWithData: 12,
        missingDays: [],
        incompleteDays: [],
      },
      caveats: [],
    },
    cannotCompute: null,
    truncated: false,
  }) as unknown as AnalyticsPanelData;

const idx = Array.from({ length: 12 }, (_, i) => i);
const PANELS: Record<string, AnalyticsPanelData> = {
  [H_A]: body(
    H_A,
    ["period", "swaps", "volumeUsd"],
    idx.map((i) => [day(i), 100 + i * 3 + (i % 4), `${5000 + i * 40}.${String(25 + i)}`]),
  ),
  [H_B]: body(
    H_B,
    ["period", "refundRate"],
    idx.map((i) => [day(i), (0.02 + (i % 5) * 0.001).toFixed(3)]),
  ),
  [H_ONE]: body(
    H_ONE,
    ["period", "swaps"],
    idx.map((i) => [day(i), 100 + i]),
  ),
};
const fakePort: PanelDataPort = {
  async stored(hash): Promise<StoredQuery | null> {
    return PANELS[hash] ? { kind: "analytics", ast: { kind: "analytics_call" } } : null;
  },
  async query() {
    throw new Error("not used");
  },
  async estimate() {
    throw new Error("not used");
  },
  registry: () => {
    throw new Error("not used");
  },
  async analytics(hash) {
    return { status: 200, body: PANELS[hash]! };
  },
  async close() {},
};

let f: ApiFixture;
let root: string;
let published: string;
let orgA: string;
let wsA: string;
let wsA2: string;
let alice: string;
let vera: string;
let bob: string;
let aliceId: string;
let runOk: string;
let runOne: string;
let runIncomplete: string;
let runOther: string;
let anchorSpent = "1200000000000000000000";
let anchorCalls = 0;
const post = (tok: string, url: string, payload: unknown = {}) =>
  f.app.inject({ method: "POST", url, headers: bearer(tok), payload: payload as object });
const get = (tok: string, url: string) => f.app.inject({ url, headers: bearer(tok) });

async function seedRun(workspaceId: string, hashes: string[], o: { state?: string; ready?: boolean } = {}) {
  const runId = randomUUID();
  const budgetId = randomUUID();
  const q = (s: string, p: unknown[]) => f.db.admin.query(s, p);
  await q(
    "INSERT INTO runtime.budgets(id, tenant_id, workspace_id, tokens_total, tool_calls_total, usd_total) VALUES ($1,$2,$3,1000,10,2)",
    [budgetId, orgA, workspaceId],
  );
  await q(
    `INSERT INTO runtime.runs(id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state, source)
     VALUES ($1,$2,$3,$4,$5,'live',$6,$7,$8,'live')`,
    [runId, orgA, workspaceId, randomUUID(), randomUUID(), budgetId, `wf-${runId}`, o.state ?? "COMPLETE"],
  );
  await q(
    `INSERT INTO runtime.tasks(id, tenant_id, workspace_id, run_id, role, depth, dedup_hash, dedup_key, hypothesis_id, status, objective, result)
     VALUES ($1,$2,$3,$4,'composer',1,$5,'{}'::jsonb,'h1','DONE','compose',$6)`,
    [
      randomUUID(),
      orgA,
      workspaceId,
      runId,
      randomUUID(),
      JSON.stringify({
        result: {
          proposal: {
            patch: {
              operations: hashes.map((h, i) => ({
                op: "addPanel",
                panel: {
                  panelId: randomUUID(),
                  title: `Panel ${i}`,
                  queryRef: { hash: h, resultKind: "analytics_result" },
                },
              })),
            },
          },
        },
      }),
    ],
  );
  const ready = o.ready ?? true;
  await q(
    "INSERT INTO runtime.run_interpretation(run_id, tenant_id, workspace_id, state, finding_count) VALUES ($1,$2,$3,$4,$5)",
    [runId, orgA, workspaceId, ready ? "ready" : "none", ready ? 1 : 0],
  );
  if (ready)
    await q(
      "INSERT INTO runtime.run_findings(id, tenant_id, workspace_id, run_id, position, finding) VALUES ($1,$2,$3,$4,0,$5)",
      [
        randomUUID(),
        orgA,
        workspaceId,
        runId,
        JSON.stringify({
          id: randomUUID(),
          workspaceId,
          runId,
          agentRole: "analyst",
          status: "supported",
          kind: "change",
          basis: "observation",
          statement: "Daily swaps rose from 100 to 133 over the window.",
          facts: [
            {
              value: "100",
              unit: "swaps",
              resultRef: {
                column: "swaps",
                rowIds: [day(0)],
                queryHash: H_A,
                semanticVersion: "intents-1.0.0",
              },
            },
            {
              value: "133",
              unit: "swaps",
              resultRef: {
                column: "swaps",
                rowIds: [day(11)],
                queryHash: H_A,
                semanticVersion: "intents-1.0.0",
              },
            },
          ],
          limitations: [],
          panelIds: [],
          skepticNotes: ["a note"],
          skepticDegraded: false,
          createdAt: new Date().toISOString(),
        }),
      ],
    );
  return runId;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "wsc-caps-"));
  published = mkdtempSync(join(tmpdir(), "wsc-pub-"));
  const kp = generateKeyPairSync("ed25519");
  const keyFile = join(published, "key.pem");
  writeFileSync(keyFile, kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
  const registry = join(published, "trusted.json");
  const ch = newChallenge();
  addTrustedKey(registry, {
    publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }).toString(),
    challenge: ch,
    signature: signChallenge(ch, kp.privateKey),
  });
  Object.assign(process.env, {
    NEARESIS_CAPSULE_DIR: root,
    NEARESIS_PUBLISH_DIR: published,
    NEARESIS_PUBLISH_KEY_FILE: keyFile,
    NEARESIS_ALLOW_PLAIN_PUBLISH_KEY: "1",
    NEARESIS_TRUSTED_KEYS_FILE: registry,
  });
  f = await apiFixture({
    runtime: true,
    appOptions: {
      frontend: { panelData: fakePort, capsuleRoot: () => root },
      publishAnchorChain: async () => {
        anchorCalls += 1;
        return {
          network: "testnet",
          contract: "commit.test.testnet",
          txHash: `TXHASH${anchorCalls}`,
          viewTimestampNs: "1794517503152963705",
          spentYocto: anchorSpent,
        };
      },
    },
  });
  const a = await seedOrg(f.db.admin, "wsc-a", { alice: "owner", vera: "viewer" });
  const b = await seedOrg(f.db.admin, "wsc-b", { bob: "owner" });
  orgA = a.orgId;
  aliceId = a.users.alice!.userId;
  alice = await login(f.app, a.users.alice!.subject);
  vera = await login(f.app, a.users.vera!.subject);
  bob = await login(f.app, b.users.bob!.subject);
  const mk = async (tok: string, key: string) =>
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(tok), "idempotency-key": key },
        payload: { objective: "o", networkScope: "fixture-only" },
      })
    ).json<{ workspaceId: string }>().workspaceId;
  wsA = await mk(alice, "wsc-ws-000000001");
  wsA2 = await mk(alice, "wsc-ws-000000002");
  runOk = await seedRun(wsA, [H_A, H_B]);
  runOne = await seedRun(wsA, [H_ONE]);
  runIncomplete = await seedRun(wsA, [H_A, H_B], { state: "EXECUTING" });
  runOther = await seedRun(wsA2, [H_A, H_B]);
}, 180_000);
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
  rmSync(root, { recursive: true, force: true });
  rmSync(published, { recursive: true, force: true });
});

describe("POST /v1/workspaces/:id/capsules", () => {
  let capsuleId = "";
  let capsuleHash = "";

  it("builds a verifiable capsule from a COMPLETE run with the contract's response", async () => {
    const r = await post(alice, `/v1/workspaces/${wsA}/capsules`, { runId: runOk });
    expect(r.statusCode, r.body).toBe(201);
    const b = r.json();
    capsuleId = b.capsuleId;
    capsuleHash = b.capsuleHash;
    expect(capsuleId).toMatch(/^cap-wsrun-[a-p]{16}$/);
    expect(b).toMatchObject({
      label: "LIVE",
      runId: runOk,
      created: true,
      verifier: {
        x: { name: "swaps", unit: "unit", points: 12 },
        y: { name: "volumeUsd", unit: "unit x10^2", points: 12 },
        window: { from: day(0), to: day(11) },
        metrics: ["lag_pearson:7", "pearson", "summary"],
      },
      verification: { local: "reproduced" },
    });
    expect(["crosschecked", "skipped_wasmtime_unavailable"]).toContain(b.verification.wasm);
    // the stored capsule is owned by the org and workspace, and the capsule routes see it
    const v = (await get(alice, `/v1/capsules/${capsuleId}`)).json();
    expect(v).toMatchObject({ status: "available", capsule: { capsuleId } });
    const ver = (await get(alice, `/v1/capsules/${capsuleId}/verify`)).json();
    expect(ver.status).toBe("reproduced");
    const thesis = (await get(alice, `/v1/capsules/${capsuleId}/exports/THESIS.md`)).body;
    expect(thesis).toContain("LIVE DATA, AUTOMATED RUN");
    expect(thesis).toContain("Daily swaps rose from 100 to 133 over the window.");
  });

  it("is idempotent: a repeat returns the same capsule (200) without rebuilding", async () => {
    const r = await post(alice, `/v1/workspaces/${wsA}/capsules`, { runId: runOk });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ capsuleId, capsuleHash, created: false });
    const list = (await get(alice, `/v1/workspaces/${wsA}/capsules`)).json();
    expect(list.capsules.map((c: { capsuleId: string }) => c.capsuleId)).toEqual([capsuleId]);
    expect(list.capsules[0]).toMatchObject({
      runId: runOk,
      proofs: [],
      publication: { state: "none", public: false, versions: [] },
    });
    // concurrent builds of another run collapse to one capsule
    const [x, y] = await Promise.all([
      post(alice, `/v1/workspaces/${wsA2}/capsules`, { runId: runOther }),
      post(alice, `/v1/workspaces/${wsA2}/capsules`, { runId: runOther }),
    ]);
    expect(x.json().capsuleId).toBe(y.json().capsuleId);
    expect(x.json().capsuleHash).toBe(y.json().capsuleHash);
  });

  it("a run without two daily series is 422 RUN_NOT_CAPSULABLE with the reason, and nothing is stored", async () => {
    const r = await post(alice, `/v1/workspaces/${wsA}/capsules`, { runId: runOne });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ reasonCode: "RUN_NOT_CAPSULABLE" });
    expect(r.json().message).toMatch(/fewer than two daily numeric series/);
    expect((await get(alice, `/v1/workspaces/${wsA}/capsules`)).json().capsules).toHaveLength(1);
  });

  it("refuses runs that are not COMPLETE, foreign runs and bad bodies", async () => {
    const inc = await post(alice, `/v1/workspaces/${wsA}/capsules`, { runId: runIncomplete });
    expect(inc.statusCode).toBe(422);
    expect(inc.json().reasonCode).toBe("RUN_NOT_COMPLETE");
    const wrong = await post(alice, `/v1/workspaces/${wsA}/capsules`, { runId: runOther });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json().reasonCode).toBe("RUN_NOT_IN_WORKSPACE");
    expect((await post(alice, `/v1/workspaces/${wsA}/capsules`, { runId: "nope" })).statusCode).toBe(422);
    expect((await post(alice, `/v1/workspaces/${wsA}/capsules`, {})).statusCode).toBe(422);
  });

  it("enforces roles and tenancy: viewer 403, other org 404 on both routes, no session 401", async () => {
    const viewer = await post(vera, `/v1/workspaces/${wsA}/capsules`, { runId: runOk });
    expect(viewer.statusCode).toBe(403);
    expect((await post(bob, `/v1/workspaces/${wsA}/capsules`, { runId: runOk })).statusCode).toBe(404);
    expect((await get(bob, `/v1/workspaces/${wsA}/capsules`)).statusCode).toBe(404);
    expect((await get(vera, `/v1/workspaces/${wsA}/capsules`)).statusCode).toBe(200);
    expect((await f.app.inject({ method: "GET", url: `/v1/workspaces/${wsA}/capsules` })).statusCode).toBe(
      401,
    );
    // another org's capsule view stays hidden
    expect((await get(bob, `/v1/capsules/${capsuleId}`)).json()).toMatchObject({ status: "unavailable" });
  });

  it("a workspace-run capsule has no static publication bundle (clear 422, nothing held)", async () => {
    const r = await post(alice, "/v1/publish", { capsuleId });
    expect(r.statusCode).toBe(422);
    expect(r.json().reasonCode).toBe("PUBLICATION_NOT_SUPPORTED");
  });
});

describe("publication anchor gas is paid from credits", () => {
  const ID = "cap-anchor-gas-fixture";
  const NEAR = 10n ** 24n;
  let svc: CreditsService;
  let ctx: { orgId: string; userId: string };
  beforeAll(async () => {
    buildCapsule({
      snapshotDir: join(import.meta.dirname, "../../../packages/capsule/fixtures/snapshot-synthetic"),
      outDir: join(root, ID),
      capsuleId: ID,
    });
    writeCapsuleOwnership(join(root, ID), { orgId: orgA, workspaceId: wsA });
    svc = new CreditsService(f.db.app);
    ctx = { orgId: orgA, userId: aliceId };
  });

  it("no credits: 402 with requiredYocto and availableYocto, nothing published, nothing anchored", async () => {
    const before = anchorCalls;
    const r = await post(alice, "/v1/publish", { capsuleId: ID });
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({
      reasonCode: "INSUFFICIENT_CREDITS",
      requiredYocto: (5n * 10n ** 21n).toString(),
      availableYocto: "0",
    });
    expect(anchorCalls).toBe(before);
    expect(existsSync(join(published, ID))).toBe(false);
  });

  it("holds an estimate, charges the gas actually burnt (refKind publication, detail txHash) and releases the rest", async () => {
    await svc.topup(ctx, NEAR, {
      txHash: "TOPUP1",
      signerAccountId: "alice.testnet",
      receiverAccountId: "dep.testnet",
    });
    anchorSpent = "1200000000000000000000";
    const r = await post(alice, "/v1/publish", { capsuleId: ID });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().anchor).toMatchObject({ chain: "committed", txHash: expect.stringMatching(/^TXHASH/) });
    const acc = await svc.account(ctx);
    expect(acc.heldYocto).toBe(0n);
    expect(acc.balanceYocto).toBe(NEAR - 1_200_000_000_000_000_000_000n);
    const entries = (await svc.entries(ctx, 20)).filter((e) => e.refKind === "publication");
    const charge = entries.find((e) => e.kind === "charge")!;
    expect(charge.amountYocto).toBe("1200000000000000000000");
    expect(charge.detail).toMatchObject({ txHash: r.json().anchor.txHash, capsuleId: ID });
    expect(entries.find((e) => e.kind === "hold")!.amountYocto).toBe((5n * 10n ** 21n).toString());
    expect(entries.find((e) => e.kind === "release")!.amountYocto).toBe("3800000000000000000000");
  });

  it("a repeat publication sends no new anchor and gives the whole hold back", async () => {
    const before = anchorCalls;
    const bal = (await svc.account(ctx)).balanceYocto;
    const r = await post(alice, "/v1/publish", { capsuleId: ID });
    expect(r.statusCode, r.body).toBe(200);
    expect(anchorCalls).toBe(before);
    const acc = await svc.account(ctx);
    expect(acc.balanceYocto).toBe(bal);
    expect(acc.heldYocto).toBe(0n);
  });
});
