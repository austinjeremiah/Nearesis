/**
 * P10 integrated workflow: the near-thesis plugin carries one investment question through all 12 lifecycle steps (ch.25)
 * in ONE test, against the real kernel (plugin installed under production trust), the real Temporal InvestigationWorkflow
 * and API, and the LIVE semantic layer (cube-live :4001 over `nearesis_live`, read-only). Model decisions are scripted and
 * labelled `mock` (no paid call). The audited, published and committed capsule is the LIVE one (pinned snapshot, INSUFFICIENT_DATA); step 12 commits its hash through the chain-commit plugin (loopback chain, or NEAR testnet with NEARESIS_ACCEPT_LIVE=1).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCh,
  createPg,
  cubeReady,
  loadLiveRegistry,
  loadQuery,
  LIVE_CUBE_URL_DEFAULT,
  LIVE_DATABASE,
} from "../../services/analytics/src/index.ts";
import { validatePanelSpec } from "../../packages/canvas-schema/src/index.ts";
import {
  NEAR_THESIS_DESCRIPTOR,
  STEP_NAMES,
  activateDescriptor,
  engineInterfaces,
  validateTrace,
} from "../../plugins/near-thesis/src/index.ts";
import {
  buildLiveCapsuleInput,
  checkPublication,
  canonicalJson,
  publishStatic,
  verifyPublishManifest,
} from "../../packages/capsule/src/index.ts";
import { runFlow } from "./lib/flow.ts";
import { openStack, q, type Stack } from "./lib/stack.ts";

/** Pinned live snapshot (B3) and its recorded INSUFFICIENT_DATA run: the capsule this lifecycle audits, publishes and commits. */
const LIVE_ID = "live-20260603-20261111-live-organic-v2-15fe2ad62d6c";
const APP = join(import.meta.dirname, "..", "..");
/** Explicit live flag (same as the acceptance runner): the commit goes to NEAR testnet instead of the loopback chain. */
const LIVE_CHAIN = process.env.NEARESIS_ACCEPT_LIVE === "1";

let s: Stack;
let cubeUp = false;
beforeAll(async () => {
  cubeUp = await cubeReady(LIVE_CUBE_URL_DEFAULT);
  if (cubeUp) s = await openStack();
}, 180_000);
afterAll(async () => s?.close(), 120_000);

it("P10: all 12 lifecycle steps run in one workflow on the real kernel, Temporal and the live semantic layer", async () => {
  expect(cubeUp, "cube-live (:4001) must be reachable").toBe(true);
  // the live capsule: built from the pinned snapshot, published as a static bundle with a verified publish manifest
  const input = mkdtempSync(join(tmpdir(), "p10-live-input-"));
  buildLiveCapsuleInput({
    liveSnapshotDir: join(APP, "docs/research/live-snapshots", LIVE_ID),
    outDir: input,
    analysisCodeCommit: "3b5c4fd",
  });
  const researchBundleDir = join(APP, "docs/research/live-results", LIVE_ID);
  const pub = publishStatic({
    snapshotDir: input,
    researchBundleDir,
    root: mkdtempSync(join(tmpdir(), "p10-live-pub-")),
    signer: {
      privateKeyPem: generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    },
  });
  expect(verifyPublishManifest(pub.bundle.dir, pub.manifestPath).signature).toBe("valid");
  expect(verifyPublishManifest(pub.bundle.dir, pub.manifestPath).problems).toEqual([]);

  const f = await runFlow(s, {
    live: true,
    liveCapsule: { snapshotDir: input, researchBundleDir },
    commit: { mode: LIVE_CHAIN ? "live" : "fixture", note: "P10 lifecycle step 12, live capsule hash" },
  });
  const why = f.trace.steps
    .map((x) => `${x.name}:${x.status}:${x.reason_code ?? ""}:${x.detail ?? ""}`)
    .join(" | ");

  // trace: 12 ordered steps, every upstream hash continuous, no mock outside inference
  const v = validateTrace(f.trace);
  expect(v.violations, why).toEqual([]);
  expect(f.trace.steps.map((x) => x.name)).toEqual([...STEP_NAMES]);
  for (const n of STEP_NAMES.slice(0, 11))
    expect(f.trace.steps.find((x) => x.name === n)!.status, why).toBe("completed");
  const commit = f.trace.steps.find((x) => x.name === "commit")!;
  expect(commit.status, why).toBe("completed");
  expect(commit.mode).toBe(LIVE_CHAIN ? "live" : "fixture");
  // step 12 committed the LIVE capsule's hash through the plugin, an owner approval and the kernel gateway
  expect(f.capsuleHash).toBe(pub.bundle.capsuleHash);
  expect(f.commit!.payloadHash).toBe(pub.bundle.capsuleHash);
  expect(f.commit!.contract).toBe("commit.majorlynx5104.testnet");
  expect(f.commit!.method).toBe("commit_hash");
  if (LIVE_CHAIN) {
    // read back at FINAL: the transaction succeeded, its args carry the hash, and the contract view holds it
    const rb = f.commit!.readback as {
      finality: string;
      succeeded: boolean;
      argsHash: string;
      equal: boolean;
    };
    expect(rb.finality).toBe("FINAL");
    expect(rb.succeeded).toBe(true);
    expect(rb.argsHash).toBe(pub.bundle.capsuleHash);
    expect(rb.equal).toBe(true);
    expect(BigInt(f.commit!.spentYocto!)).toBeLessThanOrEqual(10n ** 22n); // 0.01 NEAR budget
  } else expect((f.commit!.readback as { signatureVerified: boolean }).signatureVerified).toBe(true);
  const discover = f.trace.steps.find((x) => x.name === "discover")!;
  expect(discover.mode).toBe("live");
  const mocks = f.trace.steps.filter((x) => x.mode === "mock").map((x) => x.name);
  expect(mocks.sort()).toEqual(["compose", "execute", "investigate", "plan"].sort());

  // the descriptor's five registration points are all present and active against the running kernel
  for (const point of Object.keys(NEAR_THESIS_DESCRIPTOR.registrations) as Array<
    keyof typeof NEAR_THESIS_DESCRIPTOR.registrations
  >)
    expect(NEAR_THESIS_DESCRIPTOR.registrations[point].length, point).toBeGreaterThan(0);
  const act = activateDescriptor(NEAR_THESIS_DESCRIPTOR, engineInterfaces());
  expect(act.state, JSON.stringify(act.unmet)).toBe("enabled");
  expect(act.rejected).toEqual([]);
  expect(new Set(act.accepted.map((a) => a.type)).size).toBe(5);

  // discovery and the query came from the LIVE layer: live catalog ids and the live registry's own hash
  const ls = f.liveSemantic!;
  expect(ls.source).toBe("live");
  const liveIds = new Set(loadLiveRegistry().metrics.map((m) => m.id));
  expect(ls.metrics.length).toBeGreaterThan(5);
  expect(ls.metrics.every((m) => liveIds.has(m))).toBe(true);
  expect(ls.dataWindows.near_daily_tx).toBeTruthy();

  // the numbers equal a direct read-only ClickHouse query of nearesis_live (the layer under cube-live)
  const ch = createCh({ database: LIVE_DATABASE });
  try {
    const rs = await ch.query({
      query:
        "SELECT toString(block_date) AS d, sum(tx_count) AS n FROM near_daily_tx WHERE block_date >= '2026-10-01' AND block_date < '2026-11-01' GROUP BY block_date ORDER BY block_date",
      format: "JSONEachRow",
    });
    const direct = (await rs.json()) as Array<{ d: string; n: string }>;
    const mcol = ls.columns.findIndex((c) => c.name !== "near_daily_tx_live.day" && c.type !== "time");
    expect(direct.length).toBe(ls.rows.length);
    const got = ls.rows.map((r) => Number(r[mcol]));
    expect(got).toEqual(direct.map((r) => Number(r.n)));
  } finally {
    await ch.close();
  }

  // the real workflow ran on the live source; its persisted panel re-uses the discovered query hash and addresses live members only
  const run = await q<{ source: string; state: string }>(
    s.env,
    s.env.tenantId,
    "SELECT source, state FROM runs WHERE id=$1",
    [f.runId],
  );
  expect(run[0]!.source).toBe("live");
  const canvas = (await s.owner.call("GET", `/v1/workspaces/${f.workspaceId}/canvas`)).json as {
    panels: Array<{ panelId: string; queryRef: { hash: string } }>;
  };
  expect(canvas.panels.length).toBeGreaterThanOrEqual(1);
  const members = new Set(loadLiveRegistry().metrics.flatMap((m) => [m.id, m.cubeMember]));
  const pg = createPg();
  try {
    for (const p of canvas.panels) {
      expect(validatePanelSpec(p).ok).toBe(true);
      expect(p.queryRef.hash).toBe(ls.queryHash);
      const saved = await loadQuery(pg, p.queryRef.hash);
      expect(saved).toBeTruthy();
      const ms = (saved!.ast as { measures: string[] }).measures;
      expect(ms.length > 0 && ms.every((m) => members.has(m)), JSON.stringify(ms)).toBe(true);
    }
  } finally {
    await pg.end();
  }

  // publication: every number in THESIS.md cites a computed result; the capsule reproduced offline
  const thesis = f.texts["THESIS.md"]!;
  const manifest = JSON.parse(readFileSync(`${f.capsuleDir}/manifest.json`, "utf8")) as {
    results: Array<{ id: string; value: string }>;
    capsuleHash: string;
  };
  const pubCheck = checkPublication(thesis, manifest.results);
  expect(pubCheck.ok, JSON.stringify(pubCheck.violations.slice(0, 3))).toBe(true);
  expect(pubCheck.numbersChecked).toBeGreaterThan(5);
  expect(f.publication?.label).toBeTruthy();
  expect(createHash("sha256").update(canonicalJson(manifest.results)).digest("hex")).toMatch(
    /^[0-9a-f]{64}$/,
  );
}, 600_000);
