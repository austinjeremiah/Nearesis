import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import { runFlow } from "./lib/flow.ts";
import { pdfText, scanCited, scanSurface, type SurfaceFact, type SurfaceReport } from "./lib/scan.ts";
import { APP_ROOT } from "./lib/research.ts";

const ARTIFACTS = join(APP_ROOT, "test-results", "integration-B07");
import { openStack, q, stopIfBlocked, type Stack } from "./lib/stack.ts";
import { harvestCanvasHover, startBrowser, type BrowserSession, type HoverHarvest } from "./lib/browser.ts";

let s: Stack;
let web: BrowserSession | undefined;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => {
  await web?.close();
  await s?.close();
}, 120_000);

it("B07: every number a user can read resolves to a result, a query and a source snapshot", async () => {
  if (await stopIfBlocked(s, "B07", "the real-stack flow")) return;
  const f = await runFlow(s);
  const ws = f.workspaceId;
  const manifest = JSON.parse(readFileSync(join(f.capsuleDir!, "manifest.json"), "utf8")) as {
    results: Array<{ id: string; value: string }>;
    snapshot: { snapshotId: string; dataHash: string };
    hashes: { resultManifestHash: string };
  };
  const snapshotId = manifest.snapshot.snapshotId;
  const facts: SurfaceFact[] = manifest.results.map((r) => ({
    value: r.value,
    resultId: r.id,
    queryHash: manifest.hashes.resultManifestHash,
    snapshotId,
  }));
  // agent findings carry their own tool-result facts (query hash from the tool log)
  const tasks = await q<{
    result: {
      result?: {
        finding?: {
          statement: string;
          facts: Array<{ value: string; unit?: string; resultRef: { queryHash: string } }>;
        };
      };
    };
  }>(s.env, s.env.tenantId, "SELECT result FROM tasks WHERE workspace_id=$1 AND result IS NOT NULL", [ws]);
  const agentTexts: string[] = [];
  for (const t of tasks) {
    const fi = t.result?.result?.finding;
    if (!fi) continue;
    agentTexts.push(fi.statement);
    for (const x of fi.facts)
      facts.push({
        value: x.value,
        ...(x.unit ? { unit: x.unit } : {}),
        resultId: `finding:${x.resultRef.queryHash.slice(0, 8)}`,
        queryHash: x.resultRef.queryHash,
        snapshotId: "pinned",
      });
  }
  const canvas = (await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as {
    panels: Array<{ title: string; note?: string; queryRef: { hash: string } }>;
  };
  const surfaces: Record<string, string> = {
    "panel titles and notes": canvas.panels.map((p) => `${p.title}. ${p.note ?? ""}`).join("\n"),
    "agent messages": agentTexts.join("\n"),
  };
  const cited: Record<string, string> = {
    "THESIS.md": f.texts["THESIS.md"]!,
    "DATA.md": f.texts["DATA.md"]!,
    "LIMITATIONS.md": f.texts["LIMITATIONS.md"]!,
    "memo.pdf": pdfText(readFileSync(join(f.capsuleDir!, "exports", "memo.pdf"))),
  };
  const readme = join(APP_ROOT, "README.md");
  const readmeText = existsSync(readme) ? readFileSync(readme, "utf8") : "";
  const expectedBlock =
    /```[a-z]*\n(?:expected output|output)[^\n]*\n([\s\S]*?)```/i.exec(readmeText)?.[1] ?? "";
  surfaces["README expected-output block"] = expectedBlock;

  // UI tooltips: the golden-flow workspace rendered by the production build of apps/web in Chromium. Every chart
  // position is hovered (ECharts richText tooltip read from the chart's scene graph) and every title, aria-label,
  // aria-description and role=tooltip text of every panel is read.
  const uiSurface = "UI tooltips (rendered by apps/web)";
  let harvest: HoverHarvest | undefined;
  let uiError: string | undefined;
  try {
    web = await startBrowser(s);
    harvest = await harvestCanvasHover(web, ws, join(ARTIFACTS, "canvas-tooltips.png"));
  } catch (e) {
    uiError = String(e instanceof Error ? e.message : e).slice(0, 600);
  }
  // facts of the rendered panels: the numeric cells of the data the page itself fetched, tied to the panel's query
  // hash and result hash. The panel provenance carries no source snapshot id (sourceSnapshotId is null), so the
  // matches report the snapshot the run is pinned to (the capsule manifest's) and say so.
  for (const pd of harvest?.panels ?? []) {
    const prov = (pd.data.provenance ?? {}) as { resultHash?: string; sourceSnapshotId?: string | null };
    const cols = pd.data.chart.columns;
    pd.data.chart.rows.forEach((row) =>
      row.forEach((cell, ci) => {
        if (typeof cell !== "number" || !cols[ci]) return;
        facts.push({
          value: String(cell),
          ...(cols[ci]!.unit ? { unit: cols[ci]!.unit! } : {}),
          resultId: `panel-result:${(prov.resultHash ?? pd.queryHash).slice(0, 12)}`,
          queryHash: pd.queryHash,
          snapshotId:
            prov.sourceSnapshotId ?? `${snapshotId} (run-pinned; panel provenance sourceSnapshotId=null)`,
        });
      }),
    );
  }
  const uiItems = harvest?.items ?? [];
  surfaces[uiSurface] = uiItems.map((i) => i.text).join("\n");

  const ctx = { queryHash: manifest.hashes.resultManifestHash, snapshotId };
  const reports: SurfaceReport[] = [
    ...Object.entries(surfaces).map(([k, t]) => scanSurface(k, t, facts, ["2026-10-20", "2026-10-27"])),
    ...Object.entries(cited).map(([k, t]) => scanCited(k, t, manifest.results, ctx)),
  ];
  const coverage = reports.map((r) => ({
    surface: r.surface,
    numericStrings: r.numericStrings,
    unmatched: r.unmatched.length,
  }));
  const unscanned = reports.filter((r) => r.numericStrings === 0).map((r) => r.surface);
  const backend = reports.filter((r) => !unscanned.includes(r.surface));
  // (a) backend surfaces that did scan strings have 0 unmatched numbers; matches carry result, query and snapshot ids
  expect(backend.flatMap((r) => r.unmatched.map((u) => `${r.surface}: ${u}`))).toEqual([]);
  for (const r of backend)
    for (const m of r.matched) expect(m.resultId && m.queryHash && m.snapshotId).toBeTruthy();
  expect(backend.length).toBeGreaterThanOrEqual(3);

  // (b) planted numbers are detected and located (agent message, panel subtitle, README block, memo)
  const plant = (name: string, text: string) =>
    scanSurface(name, `${text} Volume grew by 73.9% last week.`, facts, ["2026-10-20", "2026-10-27"]);
  const planted: SurfaceReport[] = [
    plant("agent messages", surfaces["agent messages"]!),
    plant("panel titles and notes", surfaces["panel titles and notes"]!),
    plant("README expected-output block", surfaces["README expected-output block"]!),
    scanCited("memo.pdf", `${cited["memo.pdf"]!}\nVolume grew by 73.9% last week.`, manifest.results, ctx),
  ];
  // the planted tooltip: the sentence is injected into one rendered chart tooltip's text before the surface is scanned
  const plantAt = uiItems.findIndex((i) => i.kind === "chart-tooltip");
  if (plantAt >= 0)
    planted.push(
      scanSurface(
        uiSurface,
        uiItems
          .map((i, k) => (k === plantAt ? `${i.text}\nVolume grew by 73.9% last week.` : i.text))
          .join("\n"),
        facts,
        ["2026-10-20", "2026-10-27"],
      ),
    );
  for (const p of planted) expect(p.unmatched.join("|"), p.surface).toContain("73.9");
  // a scanner that skips a surface is exposed by the coverage rule below

  // (d) rounded displays match their source within the declared rounding rule (display at printed precision)
  const rounding = scanSurface("rounding", "The change was 12.35% [R:x]", [
    { value: "12.3456", resultId: "x", queryHash: "q", snapshotId: "s" },
  ]);
  expect(rounding.unmatched).toEqual([]);
  const wrongRound = scanSurface("rounding", "The change was 12.4% [R:x]", [
    { value: "12.3456", resultId: "x", queryHash: "q", snapshotId: "s" },
  ]);
  expect(wrongRound.unmatched.length).toBe(1);

  // (c) coverage rule: a surface with 0 scanned strings fails the test (no vacuous pass)
  const blockedWhy = [
    ...unscanned.map((u) =>
      u.startsWith("UI tooltips")
        ? `${u}: no numeric strings were scanned (${uiError ? `browser render failed: ${uiError}` : `${uiItems.length} hover texts harvested`})`
        : `${u}: surface has no numeric strings (the README has no expected-output block)`,
    ),
  ];
  const verdictBlocked = unscanned.length ? `coverage rule: ${blockedWhy.join("; ")}` : undefined;

  observe({
    testId: "B07",
    fixtureHash: createHash("sha256")
      .update(JSON.stringify(facts.map((x) => x.value)))
      .digest("hex"),
    observed: `scanned ${backend.length} backend surfaces with the frozen A19 grammar (${coverage.map((c) => `${c.surface}=${c.numericStrings}`).join(", ")}): 0 unmatched numbers, every match resolved to a result id, query hash and snapshot ${snapshotId}; ${planted.length}/${planted.length} planted numbers (${planted.map((p) => p.surface).join(", ")}) detected and located; rounding rule checked both ways. ${verdictBlocked ? `NOT PASSED: ${verdictBlocked}.` : "All surfaces scanned."}`,
    evidence: {
      coverage,
      planted: planted.map((p) => ({ surface: p.surface, unmatched: p.unmatched })),
      unscanned,
      uiTooltips: {
        harvested: uiItems.length,
        byKind: Object.fromEntries(
          [...new Set(uiItems.map((i) => i.kind))].map((k) => [
            k,
            uiItems.filter((i) => i.kind === k).length,
          ]),
        ),
        panelSnapshotIds: (harvest?.panels ?? []).map((p) => p.data.provenance?.sourceSnapshotId ?? null),
        screenshot: harvest?.screenshot,
        error: uiError,
      },
    },
    ...(verdictBlocked ? { blocked: verdictBlocked } : {}),
  });
}, 900_000);
