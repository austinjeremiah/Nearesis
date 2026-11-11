import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import { runFlow } from "./lib/flow.ts";
import { scanSurface, type SurfaceFact, type SurfaceReport } from "./lib/scan.ts";
import { APP_ROOT } from "./lib/research.ts";
import { openStack, q, stopIfBlocked, type Stack } from "./lib/stack.ts";

let s: Stack;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => s?.close(), 120_000);

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
    "THESIS.md": f.texts["THESIS.md"]!,
    "DATA.md": f.texts["DATA.md"]!,
    "LIMITATIONS.md": f.texts["LIMITATIONS.md"]!,
    "memo.pdf": readFileSync(join(f.capsuleDir!, "exports", "memo.pdf"))
      .toString("latin1")
      .replace(/[^\x20-\x7e\n]/g, " "),
  };
  const readme = join(APP_ROOT, "README.md");
  const readmeText = existsSync(readme) ? readFileSync(readme, "utf8") : "";
  const expectedBlock =
    /```[a-z]*\n(?:expected output|output)[^\n]*\n([\s\S]*?)```/i.exec(readmeText)?.[1] ?? "";
  surfaces["README expected-output block"] = expectedBlock;
  surfaces["UI tooltips (rendered by apps/web)"] = ""; // needs the browser; recorded below

  const reports: SurfaceReport[] = Object.entries(surfaces).map(([k, t]) =>
    scanSurface(k, t, facts, ["2026-10-20", "2026-10-27"]),
  );
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
  const planted = [
    plant("agent messages", surfaces["agent messages"]!),
    plant("panel titles and notes", surfaces["panel titles and notes"]!),
    plant("README expected-output block", surfaces["README expected-output block"]!),
    plant("memo.pdf", surfaces["memo.pdf"]!),
  ];
  for (const p of planted) expect(p.unmatched, p.surface).toContain("73.9%");
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
        ? `${u}: needs a browser render of apps/web (Engine B)`
        : `${u}: surface has no numeric strings (the README has no expected-output block)`,
    ),
  ];
  const verdictBlocked = unscanned.length ? `coverage rule: ${blockedWhy.join("; ")}` : undefined;

  observe({
    testId: "B07",
    fixtureHash: createHash("sha256")
      .update(JSON.stringify(facts.map((x) => x.value)))
      .digest("hex"),
    observed: `scanned ${backend.length} backend surfaces with the frozen A19 grammar (${coverage.map((c) => `${c.surface}=${c.numericStrings}`).join(", ")}): 0 unmatched numbers, every match resolved to a result id, query hash and snapshot ${snapshotId}; 4/4 planted numbers (agent message, panel subtitle, README block, memo) detected and located; rounding rule checked both ways. ${verdictBlocked ? `NOT PASSED: ${verdictBlocked}.` : "All surfaces scanned."}`,
    evidence: {
      coverage,
      planted: planted.map((p) => ({ surface: p.surface, unmatched: p.unmatched })),
      unscanned,
    },
    ...(verdictBlocked ? { blocked: verdictBlocked } : {}),
  });
}, 900_000);
