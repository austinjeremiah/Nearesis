import { generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PublishBlockedError,
  buildCapsule,
  buildLiveCapsuleInput,
  publishStatic,
  verifyCapsule,
  verifyPublishManifest,
} from "../src/index.ts";
import type { PublishManifest } from "../src/index.ts";
import { APP, tmp } from "./helpers.ts";

/** The pinned live snapshot B3 froze, and its recorded INSUFFICIENT_DATA run. Read-only inputs. */
const LIVE_ID = "live-20260603-20261111-live-organic-v2-15fe2ad62d6c";
const LIVE_SNAPSHOT = join(APP, "docs", "research", "live-snapshots", LIVE_ID);
const LIVE_RESULTS = join(APP, "docs", "research", "live-results", LIVE_ID);
const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const text = (dir: string, f: string): string => readFileSync(join(dir, f), "utf8");

describe("live capsule publication (pinned live snapshot)", () => {
  const input = tmp("live-input-");
  buildLiveCapsuleInput({ liveSnapshotDir: LIVE_SNAPSHOT, outDir: input, analysisCodeCommit: "3b5c4fd" });
  const root = tmp("live-pub-");
  const r = publishStatic({
    snapshotDir: input,
    researchBundleDir: LIVE_RESULTS,
    root,
    signer: { privateKeyPem: pem },
  });
  const dir = r.bundle.dir;
  const m = JSON.parse(readFileSync(r.manifestPath, "utf8")) as PublishManifest;

  it("verifies offline and binds the pinned snapshot id and data hash", () => {
    expect(verifyPublishManifest(dir, r.manifestPath).problems).toEqual([]);
    expect(m.snapshot.snapshotId).toBe(LIVE_ID);
    expect(m.snapshot.label).toBe("LIVE");
    expect(m.snapshot.dataHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("publishes executed queries only: every sql file has an execution record equal to the snapshot's raw file hash", () => {
    const raw = new Map(
      (
        JSON.parse(text(dir, "snapshot-manifest.json")) as { files: Array<{ path: string; sha256: string }> }
      ).files.map((f) => [f.path, f.sha256]),
    );
    expect(m.queries.length).toBeGreaterThanOrEqual(3);
    for (const q of m.queries) {
      expect(text(dir, q.path)).toMatch(/^-- EXECUTED against nearesis_live/);
      expect(q.execution, q.queryId).toBeTruthy();
      expect(raw.get(q.execution!.resultFile)).toBe(q.execution!.resultSha256);
    }
    expect(
      readdirSync(join(dir, "sql")).some((f) => /synthetic/i.test(readFileSync(join(dir, "sql", f), "utf8"))),
    ).toBe(false);
  });

  it("resolves every result to executed queries, a source snapshot and a citing document", () => {
    const ids = new Set(m.queries.map((q) => q.queryId));
    expect(m.lineage.length).toBeGreaterThan(10);
    for (const l of m.lineage) {
      expect(l.sourceSnapshotId).toBe(LIVE_ID);
      expect(l.queryIds?.length).toBeGreaterThan(0);
      for (const id of l.queryIds!) expect(ids.has(id), `${l.resultId} -> ${id}`).toBe(true);
    }
    const research = m.lineage.find((l) => l.resultId === "research-delta-mae")!;
    expect(research.queryIds).toEqual(["q-account_daily_activity", "q-price", "q-swaps"]);
    expect(research.citedIn).toContain("MEMO.pdf");
    expect(m.memo.charts.every((c) => c.queryIds!.every((id) => ids.has(id)))).toBe(true);
  });

  it("states INSUFFICIENT_DATA and METHOD_NOT_VALIDATED and never claims significance", () => {
    const all = ["THESIS.md", "EXPERIMENTS.md", "LIMITATIONS.md", "PREREGISTRATION.md"]
      .map((f) => text(dir, f))
      .join("\n");
    expect(all).toContain("INSUFFICIENT_DATA");
    expect(all).toContain("METHOD_NOT_VALIDATED");
    expect(all).toContain("post-hoc");
    expect(all).not.toMatch(/fixture run and makes no live claim/);
    const memo = readFileSync(join(dir, "MEMO.pdf")).toString("latin1");
    expect(memo).toContain("INSUFFICIENT_DATA");
    expect(memo).toContain("no significance is claimed");
    for (const bad of [
      /is statistically significant/i,
      /significant improvement/i,
      /outperform/i,
      /\bproves?\b/i,
    ])
      expect(`${all}\n${memo}`).not.toMatch(bad);
    expect(m.lineage.find((l) => l.resultId === "research-status")!.value).toBe("INSUFFICIENT_DATA");
  });

  it("detects tampering with an executed query file and with its recorded result hash", () => {
    const d = tmp("live-tamper-");
    cpSync(dir, d, { recursive: true });
    const mp = join(d, "..", "m.json");
    cpSync(r.manifestPath, mp);
    const sql = join(d, "sql", "q-swaps.sql");
    writeFileSync(sql, `${readFileSync(sql, "utf8")}-- edited\n`);
    expect(verifyPublishManifest(d, mp).ok).toBe(false);
  });

  it("blocks a live bundle whose query was never executed (no result file)", () => {
    const bad = tmp("live-unexec-");
    cpSync(input, bad, { recursive: true });
    // a live snapshot descriptor that lists a query without a result file cannot produce an execution record
    const p = join(bad, "raw", "live-snapshot.json");
    const j = JSON.parse(readFileSync(p, "utf8")) as { queries: Record<string, string> };
    j.queries.ghost = "SELECT 1";
    writeFileSync(p, JSON.stringify(j));
    expect(() =>
      publishStatic({ snapshotDir: bad, researchBundleDir: LIVE_RESULTS, root: tmp("x-") }),
    ).toThrow();
  });

  it("the capsule itself rebuilds with the same hash and verifies (recorded research run)", async () => {
    const out = tmp("live-cap-");
    const mf = buildCapsule({
      snapshotDir: input,
      outDir: out,
      researchBundleDir: LIVE_RESULTS,
      registrationLabel: "post-hoc registration",
    });
    expect(existsSync(join(out, "manifest.json"))).toBe(true);
    expect(mf.label).toBe("LIVE");
    expect(mf.research?.reproduce).toBe("recorded");
    const rep = await verifyCapsule(out, { research: "reproduce", wasm: "skip" });
    expect(rep.status).toBe("reproduced");
    expect(PublishBlockedError).toBeTruthy();
  });
});
