/**
 * SEC13: integrity chain. PASS: a one-byte alteration, made directly in storage, in each of six artefact classes
 * (archive object, evidence item, outbox event, plugin manifest, semantic model, capsule) is detected on read with
 * `integrity_error` before the artefact is used; a quarantine record and a trace (audit) event are written and the state
 * is visible through the API; clean artefacts are never flagged (100 clean reads each); no derived row is written from a
 * corrupted input.
 * Real kernel, real Postgres (disposable), real Fastify API for capsules, real registry file, real plugin execution.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { latestRegistryFile } from "../../services/analytics/src/index.ts";
import { buildApp } from "../../apps/api/src/app.ts";
import { checkRegistryFile, loadVerifiedRegistry } from "../../apps/api/src/verified-registry.ts";
import { buildCapsule, writeCapsuleOwnership } from "../../packages/capsule/src/index.ts";
import { OutboxPublisher } from "../../packages/kernel/src/index.ts";
import type { ArtefactClass } from "../../packages/kernel/src/index.ts";
import { addNode, addPanel, newWs, snapshot, world } from "../../packages/kernel/test/history/helpers.ts";
import type { World } from "../../packages/kernel/test/history/helpers.ts";
import { rig } from "./_plugin-harness.ts";
import type { Rig } from "./_plugin-harness.ts";

const CLEAN_READS = 100;
const ROOT = process.cwd();
let w: World;
let r: Rig | undefined;
const tmp: string[] = [];
beforeAll(async () => {
  w = await world("sec13");
}, 120_000);
afterAll(async () => {
  await r?.drop();
  await w?.db.drop();
  tmp.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** One byte of a JSON text changed: the first letter of the first string value is replaced by another letter. */
function flipJson(text: string, from = 0): string {
  const m = /:\s*"([A-Za-z])/g;
  m.lastIndex = from;
  const hit = m.exec(text);
  if (!hit) throw new Error("no string value to flip");
  const at = hit.index + hit[0].length - 1;
  const c = text[at]!;
  return text.slice(0, at) + (c === "q" ? "z" : "q") + text.slice(at + 1);
}

/** Direct storage write as the superuser, with user triggers (immutability guards) switched off for that statement. */
async function storage(table: string, sql: string, params: unknown[] = []): Promise<void> {
  const c = await w.db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await c.query(sql, params);
    await c.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

const reasonOf = (e: unknown): string => (e as { reasonCode?: string }).reasonCode ?? "none";
const attempt = (fn: () => Promise<unknown>): Promise<string> =>
  fn().then(
    () => "used",
    (e) => reasonOf(e),
  );
const count = async (sql: string): Promise<number> => Number((await w.db.admin.query(sql)).rows[0].n);
const derivedCounts = async () => ({
  events: await count("SELECT count(*)::int n FROM workspace_events"),
  nodes: await count("SELECT count(*)::int n FROM evidence_nodes"),
  branches: await count("SELECT count(*)::int n FROM branches"),
  receipts: await count("SELECT count(*)::int n FROM consumer_receipts"),
  derived: await count("SELECT count(*)::int n FROM sec13_derived"),
  snapshots: await count("SELECT count(*)::int n FROM history_snapshots"),
});

it("SEC13: a one-byte alteration in any of six stored artefact classes is detected before use", async () => {
  await w.db.admin.query("CREATE TABLE sec13_derived(event_id uuid)");
  await w.db.admin.query("GRANT SELECT, INSERT ON sec13_derived TO nearesis_app");

  // ---- valid instances of each class, created through the application
  const bytes = Buffer.from("SEC13 raw archive object: swap 42 USD 1337.00 at block 99999\n");
  const obj = await w.h.objects.put(w.owner, bytes);
  const ws = (await newWs(w)).workspaceId;
  await addPanel(w, ws, 0);
  await addNode(w, ws, "claim", "Original claim");
  const snap = await snapshot(w, ws, "sec13 snapshot");
  const snapshotId = snap.snapshotId as string;

  // semantic model: a copy of the real registry file
  const regDir = mkdtempSync(join(tmpdir(), "sec13-reg-"));
  tmp.push(regDir);
  const regFile = join(regDir, "metrics.vtest.json");
  copyFileSync(latestRegistryFile(), regFile);

  // capsule behind the real API
  const capDir = mkdtempSync(join(tmpdir(), "sec13-cap-"));
  tmp.push(capDir);
  process.env.NEARESIS_CAPSULE_DIR = capDir;
  const app = await buildApp({ kernel: w.k, nodeEnv: "test" });
  const token = (
    (
      await app.inject({
        method: "POST",
        url: "/v1/dev/login",
        payload: { oidcSubject: w.orgA.users.alice!.subject },
      })
    ).json() as { token: string }
  ).token;
  const auth = { authorization: `Bearer ${token}` };
  const capId = "sec13-capsule";
  buildCapsule({
    snapshotDir: join(ROOT, "packages/capsule/fixtures/snapshot-synthetic"),
    outDir: join(capDir, capId),
  });
  writeCapsuleOwnership(join(capDir, capId), { orgId: w.orgA.orgId, workspaceId: ws });
  const manifest = JSON.parse(readFileSync(join(capDir, capId, "manifest.json"), "utf8")) as {
    publication: { files: Array<{ path: string; sha256: string }> };
  };
  const exportEntry = manifest.publication.files[0]!;
  const exportUrl = `/v1/capsules/${capId}/${exportEntry.path.replace(/^exports\//, "exports/")}`;
  const exportFile = join(capDir, capId, exportEntry.path);

  // plugin manifest: the real execution path on its own database
  r = await rig({ prefix: "sec13p" });
  expect((await r.invoke({ action: "ok" })).state).toBe("ok"); // loads and caches the module

  // outbox: events of this workspace are unpublished; the consumer derives a row per event it is given
  const pub = new OutboxPublisher(w.db.app);
  let consumed = 0;
  pub.register("sec13", async ({ tx, event }) => {
    consumed++;
    await tx.query("INSERT INTO sec13_derived(event_id) VALUES ($1)", [event.eventId]);
  });
  const pending = await w.db.admin.query(
    "SELECT o.id, o.event_id, e.payload FROM outbox o JOIN workspace_events e ON e.event_id = o.event_id WHERE o.published_at IS NULL ORDER BY e.seq",
  );
  expect(pending.rows.length).toBeGreaterThanOrEqual(3);
  const victim = pending.rows[0] as { id: string; event_id: string; payload: unknown };

  const readers: Record<Exclude<ArtefactClass, "outbox_event">, () => Promise<string>> = {
    archive_object: () => attempt(() => w.h.objects.get(w.owner, obj.hash)),
    evidence_item: () => attempt(() => w.h.snapshots.view(w.owner, ws, snapshotId, "all")),
    plugin_manifest: async () => {
      const x = await r!.invoke({ action: "ok" });
      return x.state === "ok" ? "used" : String((x as { reasonCode?: string }).reasonCode);
    },
    semantic_model: () => attempt(() => loadVerifiedRegistry(w.k.integrity, regFile)),
    capsule: async () => {
      const x = await app.inject({ method: "GET", url: exportUrl, headers: auth });
      return x.statusCode === 200 ? "used" : String((x.json() as { reasonCode?: string }).reasonCode);
    },
  };
  // outbox verification is exercised through the publisher (verifyRow, then runOnce) below

  // ---- (c) clean reads: 100 per class, none flagged (outbox: verifyRow over 100 passes of the clean row)
  const clean: Record<string, number> = {};
  for (const [cls, read] of Object.entries(readers)) {
    let ok = 0;
    for (let i = 0; i < CLEAN_READS; i++) if ((await read()) === "used") ok++;
    clean[cls] = ok;
    expect(ok, `${cls} clean reads`).toBe(CLEAN_READS);
  }
  const claim = (
    await w.db.admin.query(
      "SELECT o.id, o.event_id, o.org_id, o.workspace_id, e.payload, e.payload_hash FROM outbox o JOIN workspace_events e ON e.event_id=o.event_id WHERE o.event_id=$1",
      [victim.event_id],
    )
  ).rows[0];
  let outboxClean = 0;
  for (let i = 0; i < CLEAN_READS; i++)
    if (
      await pub.verifyRow(claim).then(
        () => true,
        () => false,
      )
    )
      outboxClean++;
  clean.outbox_event = outboxClean;
  expect(outboxClean).toBe(CLEAN_READS);
  expect(checkRegistryFile(latestRegistryFile()).ok).toBe(true); // the real registry is clean

  // ---- negative control: readers that never re-hash use every corrupted artefact (they would FAIL (a))
  const before = await derivedCounts();

  // ---- corrupt one byte of each, directly in storage, bypassing the application
  await storage(
    "raw_objects",
    "UPDATE raw_objects SET bytes = set_byte(bytes, 0, get_byte(bytes, 0) # 1) WHERE hash = $1",
    [obj.hash],
  );
  const snapPayload = (
    await w.db.admin.query("SELECT payload::text t FROM history_snapshots WHERE id = $1", [snapshotId])
  ).rows[0].t as string;
  await storage("history_snapshots", "UPDATE history_snapshots SET payload = $2::jsonb WHERE id = $1", [
    snapshotId,
    flipJson(snapPayload, snapPayload.indexOf('"title"')),
  ]);
  const evPayload = (
    await w.db.admin.query("SELECT payload::text t FROM workspace_events WHERE event_id = $1", [
      victim.event_id,
    ])
  ).rows[0].t as string;
  await storage("workspace_events", "UPDATE workspace_events SET payload = $2::jsonb WHERE event_id = $1", [
    victim.event_id,
    flipJson(evPayload),
  ]);
  const regText = readFileSync(regFile, "utf8");
  writeFileSync(regFile, flipJson(regText, regText.indexOf('"metrics"')));
  const capBytes = readFileSync(exportFile);
  const flipped = Buffer.from(capBytes);
  flipped[Math.floor(flipped.length / 2)] ^= 1;
  writeFileSync(exportFile, flipped);
  const manText = (await r.db.admin.query("SELECT manifest::text t FROM plugin_installations LIMIT 1"))
    .rows[0].t as string;
  await r.db.admin.query("UPDATE plugin_installations SET manifest = $1::jsonb", [
    flipJson(manText, manText.indexOf('"requiredGrants"')),
  ]);

  // naive readers (what a write-time-only verifier does): the corrupted bytes come back as if valid
  const naive = {
    archive: Buffer.from(
      (await w.db.admin.query("SELECT bytes FROM raw_objects WHERE hash=$1", [obj.hash])).rows[0].bytes,
    ).equals(bytes),
    evidence:
      (await w.db.admin.query("SELECT 1 FROM history_snapshots WHERE id=$1", [snapshotId])).rowCount === 1,
    capsule: createHash("sha256").update(readFileSync(exportFile)).digest("hex") !== exportEntry.sha256,
  };
  expect(naive.archive).toBe(false); // bytes differ, yet a naive SELECT returns them without complaint
  expect(naive.evidence && naive.capsule).toBe(true);

  // ---- (a)(d) read every corrupted artefact through the normal application path
  const detected: Record<string, string> = {};
  for (const [cls, read] of Object.entries(readers)) detected[cls] = await read();
  // evidence used downstream: a comparison against a clean snapshot and a branch from it
  const snap2 = await snapshot(w, ws, "second");
  const compare = await attempt(() =>
    w.h.snapshots.compare(w.owner, ws, snapshotId, snap2.snapshotId as string),
  );
  // outbox: run the publisher over the unpublished events
  const run = await pub.runOnce(50);
  const lastError = (await w.db.admin.query("SELECT last_error FROM outbox WHERE id = $1", [victim.id]))
    .rows[0].last_error as string | null;
  const outboxQ = (
    await w.db.admin.query("SELECT ref FROM integrity_quarantine WHERE artefact_class = 'outbox_event'")
  ).rows.map((x) => x.ref);
  detected.outbox_event =
    /integrity check/.test(lastError ?? "") && outboxQ.length === 1 && outboxQ[0] === victim.event_id
      ? "integrity_error"
      : `undetected: ${lastError}`;
  const afterCounts = await derivedCounts();
  const sticky = await Promise.all([readers.archive_object(), readers.evidence_item()]);

  for (const cls of Object.keys(detected)) expect(detected[cls], cls).toBe("integrity_error");
  expect(compare).toBe("integrity_error");
  expect(sticky).toEqual(["integrity_error", "integrity_error"]);
  expect(run.failed).toBe(1);

  // (d) nothing derived from the corrupted inputs: the corrupted event reached no consumer; counts differ only by the
  // clean second snapshot and the clean events delivered to the consumer
  expect(
    (
      await w.db.admin.query("SELECT count(*)::int n FROM sec13_derived WHERE event_id = $1", [
        victim.event_id,
      ])
    ).rows[0].n,
  ).toBe(0);
  expect(consumed).toBe(run.delivered);
  expect(afterCounts.nodes).toBe(before.nodes);
  expect(afterCounts.branches).toBe(before.branches);
  expect(afterCounts.snapshots).toBe(before.snapshots + 1); // only the clean "second" snapshot
  expect(afterCounts.receipts - before.receipts).toBe(run.delivered);

  // (b) quarantine records and trace events exist; the state is visible through the API (and the plugin's on its own DB)
  const quarantine = (
    await w.db.admin.query(
      "SELECT artefact_class, ref, org_id FROM integrity_quarantine ORDER BY artefact_class",
    )
  ).rows as Array<{ artefact_class: string; ref: string; org_id: string | null }>;
  const classes = quarantine.map((q) => q.artefact_class);
  expect(classes).toEqual(["archive_object", "capsule", "evidence_item", "outbox_event", "semantic_model"]);
  const pluginQ = (await r.db.admin.query("SELECT artefact_class FROM integrity_quarantine")).rows.map(
    (x) => x.artefact_class,
  );
  expect(pluginQ).toEqual(["plugin_manifest"]);
  const trace = (
    await w.db.admin.query(
      "SELECT subject, reason_code FROM audit_events WHERE action = 'integrity.violation' ORDER BY subject",
    )
  ).rows;
  expect(trace).toHaveLength(5);
  expect(trace.every((t) => t.reason_code === "integrity_error")).toBe(true);
  expect(await r.auditCount("integrity.violation")).toBe(1);
  const visible = (
    await app.inject({ method: "GET", url: "/v1/integrity/quarantine", headers: auth })
  ).json() as { records: Array<{ artefactClass: string; scope: string }> };
  expect(visible.records.map((x) => x.artefactClass).sort()).toEqual(classes);
  expect(visible.records.find((x) => x.artefactClass === "semantic_model")!.scope).toBe("platform");
  // another tenant sees only platform-level records, never this tenant's refs
  const bobToken = (
    (
      await app.inject({
        method: "POST",
        url: "/v1/dev/login",
        payload: { oidcSubject: w.orgB.users.bob!.subject },
      })
    ).json() as { token: string }
  ).token;
  const bobSees = (
    (
      await app.inject({
        method: "GET",
        url: "/v1/integrity/quarantine",
        headers: { authorization: `Bearer ${bobToken}` },
      })
    ).json() as {
      records: Array<{ artefactClass: string }>;
    }
  ).records.map((x) => x.artefactClass);
  expect(bobSees).toEqual(["semantic_model"]);
  await app.close();
  delete process.env.NEARESIS_CAPSULE_DIR;

  observe({
    testId: "SEC13",
    observed: `6 artefact classes, one byte flipped directly in storage in each (raw_objects.bytes, history_snapshots.payload, workspace_events.payload, plugin_installations.manifest, registry JSON file, capsule export file): all 6 detected on read with reasonCode integrity_error (${Object.entries(
      detected,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(
        ", ",
      )}); the snapshot also failed in compare (${compare}) and a repeat read failed fast from quarantine; ${quarantine.length + pluginQ.length} quarantine records and ${trace.length + 1} integrity.violation audit events written, state visible at GET /v1/integrity/quarantine (own tenant plus platform records; the other tenant sees only the platform one); clean copies: ${Object.entries(
      clean,
    )
      .map(([k, v]) => `${k} ${v}/${CLEAN_READS}`)
      .join(
        ", ",
      )} with 0 false positives; before downstream effects: the corrupted outbox event reached 0 consumers (0 derived rows, ${run.delivered} clean events delivered), evidence nodes and branches unchanged; naive (write-time-only) readers returned the corrupted archive bytes and snapshot row without complaint, so only read-path verification detects them`,
    fixtureHash: createHash("sha256").update("sec13-v1").digest("hex"),
    evidence: {
      detected,
      cleanReads: clean,
      quarantine: quarantine
        .map((q) => ({ class: q.artefact_class, tenant: q.org_id ? "tenant" : "platform" }))
        .concat(pluginQ.map((c) => ({ class: c, tenant: "platform" }))),
      derivedBefore: before,
      derivedAfter: afterCounts,
      outbox: { delivered: run.delivered, failed: run.failed },
    },
  });
}, 600_000);
