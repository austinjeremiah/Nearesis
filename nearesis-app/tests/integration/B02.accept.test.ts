import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import { createPg, loadLiveRegistry, loadQuery, loadRegistry } from "../../services/analytics/src/index.ts";
import { runFlow } from "./lib/flow.ts";
import { approve, ask, openStack, q, runRow, stopIfBlocked, waitFor, type Stack } from "./lib/stack.ts";

let s: Stack;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => s?.close(), 120_000);

type Layer = "fixture" | "live" | "mixed" | "unknown";
const fixtureIds = () => new Set(loadRegistry().metrics.flatMap((m) => [m.id, m.cubeMember]));
const liveIds = () => new Set(loadLiveRegistry().metrics.flatMap((m) => [m.id, m.cubeMember]));
const layerOf = (measures: string[]): Layer => {
  const fx = measures.filter((m) => fixtureIds().has(m)).length;
  const lv = measures.filter((m) => liveIds().has(m)).length;
  return fx && lv
    ? "mixed"
    : lv === measures.length
      ? "live"
      : fx === measures.length
        ? "fixture"
        : "unknown";
};

it("B02: every output shows its provenance and whether it came from a fixture or a live source", async () => {
  if (await stopIfBlocked(s, "B02", "the real-stack flow")) return;
  const pg = createPg();
  try {
    // fixture run: every output class names its mode and its provenance
    const f = await runFlow(s);
    const ws = f.workspaceId;
    expect(f.trace.steps.every((x) => ["fixture", "recorded", "live", "mock"].includes(x.mode))).toBe(true);
    const src = await q<{ source: string }>(s.env, s.env.tenantId, "SELECT source FROM runs WHERE id=$1", [
      f.runId,
    ]);
    expect(src[0]!.source).toBe("fixture");
    const canvas = (await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as {
      panels: Array<{
        panelId: string;
        queryRef: { hash: string; snapshotPolicy: string };
        dataBinding: { completeness: string };
        provenanceRequired: boolean;
      }>;
    };
    const panelModes: Array<{ panelId: string; layer: Layer; hash: string }> = [];
    for (const p of canvas.panels) {
      const saved = await loadQuery(pg, p.queryRef.hash);
      expect(saved, "panel query is content-addressed and registered").toBeTruthy();
      expect(p.provenanceRequired).toBe(true);
      panelModes.push({
        panelId: p.panelId,
        layer: layerOf((saved!.ast as { measures: string[] }).measures),
        hash: p.queryRef.hash,
      });
    }
    expect(panelModes.length).toBeGreaterThan(0);
    expect(panelModes.every((m) => m.layer === "fixture")).toBe(true);
    const manifest = JSON.parse(readFileSync(join(f.capsuleDir!, "manifest.json"), "utf8")) as {
      label: string;
      snapshot: { snapshotId: string };
    };
    expect(manifest.label).toBe("SYNTHETIC");
    expect(f.texts["THESIS.md"]).toContain("SYNTHETIC");
    expect(f.texts["DATA.md"]).toMatch(/SYNTHETIC/);
    expect(f.texts["DATA.md"]).toContain(manifest.snapshot.snapshotId);
    const finds = await q<{ label: string | null; role: string }>(
      s.env,
      s.env.tenantId,
      "SELECT role, result->'result'->'artifact'->>'label' AS label FROM tasks WHERE workspace_id=$1 AND result IS NOT NULL",
      [ws],
    );
    expect(finds.length).toBeGreaterThan(2);
    for (const t of finds) expect(t.label, t.role).toBe("unattested_dev"); // scripted inference is labelled on every agent artifact

    // live question: submitted with source=live; it is recorded as live and no fixture data is substituted for it
    const lws = await s.env.kernel!.newWorkspace("B02 live source");
    const lr = await ask(s, lws, "A20-P", "Are Intents flows economically durable?", { source: "live" });
    const lsrc = await waitFor(async () => {
      const r = await q<{ source: string }>(s.env, s.env.tenantId, "SELECT source FROM runs WHERE id=$1", [
        lr.runId,
      ]);
      return r.length ? r : null;
    }, 30_000);
    expect(lsrc[0]!.source).toBe("live");
    const end = await waitFor(async () => {
      const r = (await runRow(s, lr.runId))!;
      if (r.state === "APPROVAL_NEEDED") {
        await approve(s, lr.runId);
        return null;
      }
      return ["COMPLETE", "PARTIAL", "FAILED", "BLOCKED"].includes(r.state) ? r : null;
    }, 120_000).catch(async () => (await runRow(s, lr.runId))!);
    const lcanvas = (await s.owner.call("GET", `/v1/workspaces/${lws}/canvas`)).json as {
      panels: Array<{ queryRef: { hash: string } }>;
    };
    const liveLayers: Layer[] = [];
    for (const p of lcanvas.panels) {
      const sv = await loadQuery(pg, p.queryRef.hash);
      liveLayers.push(layerOf((sv!.ast as { measures: string[] }).measures));
    }
    // a live run never carries fixture-layer panels: either live-layer panels or none, with a non-complete state explaining why
    expect(liveLayers.every((l) => l === "live")).toBe(true);
    if (liveLayers.length === 0) expect(end.state).not.toBe("COMPLETE");
    // negative control: a panel that mixes layers is classified `mixed` and would fail the check above
    expect(layerOf([...[...fixtureIds()].slice(0, 1), ...[...liveIds()].slice(0, 1)])).toBe("mixed");

    observe({
      testId: "B02",
      fixtureHash: createHash("sha256").update(JSON.stringify(panelModes)).digest("hex"),
      observed: `fixture flow: all ${f.trace.steps.length} trace steps carry a mode, runs.source=fixture, ${panelModes.length} panel(s) resolve to registered queries served by the fixture layer (${panelModes.map((m) => m.hash.slice(0, 10)).join(",")}), capsule and THESIS/DATA labelled SYNTHETIC with snapshot ${manifest.snapshot.snapshotId}, ${finds.length} agent artifacts labelled unattested_dev; live question: runs.source=live, run ended ${end.state}, ${liveLayers.length} panel(s) all served by the live layer (no fixture substitution); a mixed-layer panel is classified mixed. Limitation: the panel spec itself has no source-mode field; the mode is derived from the metric registry of the panel's registered query, and the web route renders the badge.`,
      evidence: {
        panelModes,
        liveRun: { state: end.state, panels: liveLayers.length },
        capsuleLabel: manifest.label,
      },
    });
  } finally {
    await pg.end();
  }
}, 900_000);
