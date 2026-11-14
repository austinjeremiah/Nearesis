import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import { createPg, loadQuery } from "../../services/analytics/src/index.ts";
import { buildCapsule, sha256Hex, verifyCapsule } from "../../packages/capsule/src/index.ts";
import { compareLiveToRebuild } from "../../plugins/near-thesis/src/index.ts";
import { execReq, giveLease, grant } from "../../packages/kernel/test/helpers/index.ts";
import { runFlow } from "./lib/flow.ts";
import { openStack, stopIfBlocked, type Stack } from "./lib/stack.ts";

let s: Stack;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => s?.close(), 120_000);

interface Env {
  columns: Array<{ name: string }>;
  rows: Array<Array<string | number | boolean | null>>;
  queryHash: string;
  sourceWatermarks: Record<string, string | null>;
}

/** Freezes a query's result as a snapshot directory in the capsule's own format, plus an index of the exact queries. */
function freeze(rows: Array<[string, string, string]>, queries: unknown, snapshotId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "b06-snap-"));
  mkdirSync(join(dir, "raw"), { recursive: true });
  const csv = Buffer.from(`${["date,completed,total", ...rows.map((r) => r.join(","))].join("\n")}\n`);
  const qjson = Buffer.from(`${JSON.stringify(queries, null, 2)}\n`);
  writeFileSync(join(dir, "raw", "daily_series.csv"), csv);
  writeFileSync(join(dir, "raw", "queries.json"), qjson);
  writeFileSync(
    join(dir, "snapshot.json"),
    `${JSON.stringify(
      {
        schema: "nearesis.snapshot.v1",
        snapshotId,
        label: "SYNTHETIC",
        frozenAt: "2026-11-11T00:00:00Z",
        dataset: "SYNTHETIC fixture cubes - not NEAR production data",
        claimId: "syn:b06-live-canvas",
        analysisCodeCommit: "0000000",
        series: {
          file: "raw/daily_series.csv",
          x: { column: "completed", name: "completed_swaps", unit: "swaps" },
          y: { column: "total", name: "total_swaps", unit: "swaps" },
        },
        metrics: ["pearson", "summary"],
        files: [
          { path: "raw/daily_series.csv", sha256: sha256Hex(csv), bytes: csv.length },
          { path: "raw/queries.json", sha256: sha256Hex(qjson), bytes: qjson.length },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

it("B06: the offline rebuild reproduces the live canvas data, query identity and headline result, and a difference is explained by metadata or fails", async () => {
  if (await stopIfBlocked(s, "B06", "the real-stack flow")) return;
  const f = await runFlow(s);
  const ws = f.workspaceId;
  const k = s.env.kernel!;
  const pg = createPg();
  try {
    const canvas = (await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as {
      panels: Array<{
        panelId: string;
        title: string;
        queryRef: { hash: string };
        encoding: { y?: string[] };
      }>;
    };
    expect(canvas.panels.length).toBeGreaterThan(0);
    const panel = canvas.panels[0]!;
    const saved = await loadQuery(pg, panel.queryRef.hash); // the query identity behind the chart (AST + hash)
    expect(saved, "panel query is registered content-addressed").toBeTruthy();
    expect(saved!.queryHash).toBe(panel.queryRef.hash);

    // live vector: the panel's own query, re-executed through the kernel gateway; plus the second measure for the snapshot
    await giveLease(k.kernel, k.session, ws, "semantic.query@1", [
      grant({ resource: "semantic", action: "query" }),
    ]);
    const run = async (ast: unknown): Promise<Env> => {
      const r = await k.kernel.gateway.invoke(
        k.session.principal,
        execReq(k.session, ws, "semantic.query@1", ast, { deadlineMs: 30_000 }),
      );
      expect(r.state).toBe("ok");
      return (r.payload as { envelope: Env }).envelope;
    };
    const ast = saved!.ast as { measures: string[]; time: unknown; dimensions: unknown[] };
    const live = await run(ast);
    const wide = await run({ ...ast, measures: [...ast.measures, "intents.oneclick_total_swap_count"] });
    const col = (e: Env, name: string) => e.columns.findIndex((c) => c.name === name);
    const xi = col(wide, ast.measures[0]!);
    const yi = col(wide, "intents.oneclick_total_swap_count");
    const di = col(wide, "intents.day");
    const day = (v: unknown) => String(v).slice(0, 10);
    // observed points only: a day without coverage is a gap (never zero), carried as metadata and reproduced by the rebuild
    const observed = (e: Env, name: string): Array<[string, string]> =>
      e.rows
        .filter((r) => r[col(e, name)] !== null)
        .map((r) => [day(r[col(e, "intents.day")]), String(r[col(e, name)])]);
    const liveVector = observed(live, ast.measures[0]!);
    const gapDays = live.rows
      .filter((r) => r[col(live, ast.measures[0]!)] === null)
      .map((r) => day(r[col(live, "intents.day")]));
    expect(liveVector.length).toBeGreaterThanOrEqual(5);
    expect(gapDays.length).toBeGreaterThan(0); // the fixture window has uncovered days: they must stay gaps
    const rowsAll: Array<[string, string, string]> = wide.rows
      .filter((r) => r[xi] !== null && r[yi] !== null)
      .map((r) => [day(r[di]), String(r[xi]), String(r[yi])]);
    expect(rowsAll.map((r) => [r[0], r[1]])).toEqual(liveVector);
    const watermark = Object.values(live.sourceWatermarks).find((v) => v) ?? null;

    // freeze S = exactly what the canvas shows; rebuild offline and compare
    const queries = {
      panels: [
        {
          panelId: panel.panelId,
          queryHash: saved!.queryHash,
          ast: saved!.ast,
          semanticVersion: saved!.semanticVersion,
          gapDays,
        },
      ],
    };
    const S = freeze(rowsAll, queries, "b06-canvas-2026-11-11");
    const out1 = mkdtempSync(join(tmpdir(), "b06-cap-"));
    const m1 = buildCapsule({ snapshotDir: S, outDir: out1, researchBundleDir: f.bundleDir! });
    const out2 = mkdtempSync(join(tmpdir(), "b06-cap2-"));
    const m2 = buildCapsule({ snapshotDir: S, outDir: out2, researchBundleDir: f.bundleDir! });
    expect(m2.capsuleHash).toBe(m1.capsuleHash); // the rebuild is deterministic
    const rebuiltInput = JSON.parse(
      readFileSync(join(out1, "computation", "verifier-input.json"), "utf8"),
    ) as {
      series: { x: { points: Array<[string, string]> } };
    };
    const rebuiltVector = rebuiltInput.series.x.points;
    // (a) vector equality (integers exact) and query hash equality
    const idx = JSON.parse(
      readFileSync(join(out1, "snapshot", "raw", "queries.json"), "utf8"),
    ) as typeof queries;
    const agree = compareLiveToRebuild(
      { vector: liveVector, snapshotId: "b06-canvas-2026-11-11", watermark, queryHash: panel.queryRef.hash },
      {
        vector: rebuiltVector,
        snapshotId: "b06-canvas-2026-11-11",
        watermark,
        queryHash: idx.panels[0]!.queryHash,
      },
    );
    expect(agree).toMatchObject({ equal: true, queryHashEqual: true, flag: "none" });
    // (b) each rebuilt chart links to its exact query (AST and hash) in the bundle, and the AST re-executes to that hash
    expect(idx.panels[0]!.ast).toEqual(saved!.ast);
    expect((idx.panels[0] as { gapDays: string[] }).gapDays).toEqual(gapDays); // the same uncovered days, none filled with zero
    expect(rebuiltVector.some(([d]) => gapDays.includes(d))).toBe(false);
    expect((await run(idx.panels[0]!.ast as never)).queryHash).toBe(idx.panels[0]!.queryHash);
    // (c) the headline research result (verdict, estimate, interval) is equal in the rebuilt capsule
    const liveArt = f.artifact as {
      status: string;
      estimates: { primary: { delta_mae: number } };
      uncertainty: unknown;
    };
    const rebuiltRes = JSON.parse(
      readFileSync(join(out1, "research", "research_run.json"), "utf8"),
    ) as typeof liveArt;
    expect(rebuiltRes.status).toBe(liveArt.status);
    expect(rebuiltRes.estimates.primary.delta_mae).toBe(liveArt.estimates.primary.delta_mae);
    expect(rebuiltRes.uncertainty).toEqual(liveArt.uncertainty);
    const rep = await verifyCapsule(out1, { research: "reproduce", wasm: "skip" });
    expect(rep.status).toBe("reproduced");

    // (d) variant: the live canvas has newer data than S. The difference is explained by metadata and flagged.
    const newer = compareLiveToRebuild(
      {
        vector: [...liveVector, ["2026-11-12", "999"]],
        snapshotId: "live-2026-11-12",
        watermark: "2026-11-12T00:00:00Z",
        queryHash: panel.queryRef.hash,
      },
      {
        vector: rebuiltVector,
        snapshotId: "b06-canvas-2026-11-11",
        watermark,
        queryHash: panel.queryRef.hash,
      },
    );
    expect(newer).toMatchObject({ equal: false, explained: true, flag: "different_snapshot" });
    // negative control: a canvas that edits a vector after the query returned, with the same snapshot, is an unexplained difference
    const tampered = liveVector.map((p, i) =>
      i === 2 ? ([p[0], String(Number(p[1]) + 1)] as [string, string]) : p,
    );
    const bad = compareLiveToRebuild(
      { vector: tampered, snapshotId: "b06-canvas-2026-11-11", watermark, queryHash: panel.queryRef.hash },
      {
        vector: rebuiltVector,
        snapshotId: "b06-canvas-2026-11-11",
        watermark,
        queryHash: panel.queryRef.hash,
      },
    );
    expect(bad).toMatchObject({ equal: false, explained: false, flag: "UNEXPLAINED_DIFFERENCE" });
    expect(bad.diffs).toHaveLength(1);
    // a chart with no query link is detected
    expect(
      compareLiveToRebuild(
        { vector: liveVector, snapshotId: "a", watermark, queryHash: panel.queryRef.hash },
        { vector: liveVector, snapshotId: "a", watermark, queryHash: "" },
      ).queryHashEqual,
    ).toBe(false);

    observe({
      testId: "B06",
      fixtureHash: createHash("sha256").update(JSON.stringify(rowsAll)).digest("hex"),
      observed: `panel "${panel.title}" (${liveVector.length} daily points, query ${panel.queryRef.hash.slice(0, 12)}) frozen as snapshot b06-canvas-2026-11-11 in the capsule format with a raw/queries.json index (AST + hash); two offline rebuilds give capsuleHash ${m1.capsuleHash.slice(0, 12)} both times; the rebuilt series equals the live vector exactly (integers) and the query hash is equal; the indexed AST re-executes through the kernel gateway to the same hash; headline research result (status ${rebuiltRes.status}, delta MAE ${rebuiltRes.estimates.primary.delta_mae}, uncertainty hash) equal and verifyCapsule research reproduce = ${rep.status}; a live canvas with a newer day is flagged ${newer.flag} (explained by snapshot metadata); a vector edited after query return with the same snapshot is ${bad.flag} (${bad.diffs.length} differing point).`,
      evidence: {
        agree,
        newer: { flag: newer.flag, reason: newer.reason },
        tampered: { flag: bad.flag, diffs: bad.diffs },
        capsuleHash: m1.capsuleHash,
      },
    });
  } finally {
    await pg.end();
  }
}, 900_000);
