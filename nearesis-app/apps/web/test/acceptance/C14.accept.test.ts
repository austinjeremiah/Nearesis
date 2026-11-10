/**
 * C14 — Source freshness and query provenance are shown and resolvable per panel. PASS: 4/4 panels show units, source
 * timestamp, freshness and completeness; the inspector resolves queryHash/AST/semanticVersion/sourceSnapshotId/raw
 * manifest hash and re-executing the AST through the guarded gateway reproduces the panel's result hash; on
 * late/unavailable the affected panels warn within the coalescing window and become STALE with last good data kept,
 * unaffected panels do not change; the text alternative carries units and freshness. Real kernel, real gateway/Cube/
 * ClickHouse data path (/api/semantic/panel), production web build in Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { observe } from "@nearesis/acceptance";
import { type MetricMetadata, SemanticQuery } from "@nearesis/contracts";
import { createCh, createPg, CUBE_URL_DEFAULT, defaultCubeSecret, loadRegistry } from "@nearesis/analytics";
import { createGateway, DEFAULT_POLICY, type Session } from "@nearesis/semantic-gateway";
import { compileVisualization, hashCanonical, type VizRequest } from "@nearesis/canvas-schema";
import { fixtureHash } from "@nearesis/test-fixtures";
import { Redis } from "ioredis";
import { BASE, launch } from "./harness.ts";
import { type KernelEnv, loggedIn, seedWorkspace, startKernelEnv } from "./kernel-harness.ts";

const W = { from: "2026-09-11T00:00:00Z", to: "2026-10-11T00:00:00Z" };
const SPECS = [
  { title: "Completed 1Click swaps per day", measure: "intents.oneclick_completed_swap_count", mark: "line" },
  {
    title: "Private-settlement swaps per day",
    measure: "intents.oneclick_private_settlement_swap_count",
    mark: "bar",
  },
  {
    title: "NEAR successful transactions per day",
    measure: "near.daily_successful_tx_count",
    mark: "line",
  },
  {
    title: "NEAR function-call actions per day",
    measure: "near.function_call_action_count",
    mark: "line",
  },
] as const;
// The ClickHouse facts are the synthetic P02 baseline snapshot; queries are pinned to it so provenance resolves.
const SNAPSHOT = "fx.snapshot.p02-baseline";
const AFFECTED_SOURCE = "intents-1click";

let env: KernelEnv;
let browser: Browser;
const registry = loadRegistry();
const ch = createCh();
const redis = new Redis(process.env.NEARESIS_REDIS_URL ?? "redis://127.0.0.1:56379");
const gateway = createGateway({
  cubeUrl: process.env.CUBE_URL ?? CUBE_URL_DEFAULT,
  cubeSecret: defaultCubeSecret(),
  redis: redis as never,
  registry,
  policyResolver: () => ({ ...DEFAULT_POLICY }),
  clock: () => new Date(),
  pg: createPg(),
});

beforeAll(async () => {
  env = await startKernelEnv();
  browser = await launch();
}, 300_000);
afterAll(async () => {
  await browser?.close();
  await env?.close();
  redis.disconnect();
}, 120_000);

type WmRow = {
  provider_id: string;
  newest_event_time: string | null;
  last_full_scan_at: string | null;
  gap_count: number;
  provider_lag_seconds: number | null;
  schema_version: string | null;
  state: string;
  version: string;
};
async function wmRows(): Promise<WmRow[]> {
  const rs = await ch.query({ query: "SELECT * FROM source_watermarks FINAL", format: "JSONEachRow" });
  return (await rs.json()) as WmRow[];
}
let versionCounter = Date.now() * 10;
async function setWatermark(orig: WmRow, state: string): Promise<void> {
  versionCounter += 1;
  await ch.insert({
    table: "source_watermarks",
    values: [{ ...orig, state, version: versionCounter }],
    format: "JSONEachRow",
  });
}

async function snapshot(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-testid^='panel-']")]
      .filter((e) => e.getAttribute("data-panel-kind"))
      .map((e) => ({
        id: e.getAttribute("data-testid")!.slice(6),
        state: e.getAttribute("data-panel-state"),
        freshness: e.querySelector("[data-testid='freshness']")?.textContent ?? null,
        stale: e.querySelector("[data-testid='stale-notice']")?.textContent ?? null,
        hasChart: !!e.querySelector("[data-testid^='chart-']"),
      })),
  );
}

describe("C14 freshness and provenance", () => {
  it("shows units/freshness/provenance per panel, reproduces result hashes, and degrades only affected panels", async () => {
    const orig = (await wmRows()).find((r) => r.provider_id === AFFECTED_SOURCE)!;
    expect(orig, "baseline watermark row present").toBeTruthy();
    const dummy: Session = {
      tenantId: "00000000-0000-4000-8000-00000000aaaa",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      principalId: "c14",
      aclClasses: ["human"],
    };
    const metrics = registry.metrics as unknown as MetricMetadata[];
    const panels = [];
    const asts: unknown[] = [];
    for (const [i, s] of SPECS.entries()) {
      const cube = s.measure.startsWith("near.") ? "near_usage" : s.measure.split(".")[0]!;
      const ast = SemanticQuery.parse({
        semanticVersion: registry.semanticVersion,
        sourceSnapshotId: SNAPSHOT,
        measures: [s.measure],
        dimensions: [],
        time: { field: `${cube}.day`, ...W, grain: "day" },
        filters: [],
        order: [],
        limit: 10000,
      });
      const q = await gateway.query(dummy, ast);
      if (!q.ok) throw new Error(`gateway rejected ${s.measure}: ${q.error.reasonCode}`);
      const env1 = q.envelope;
      const req = {
        panelId: crypto.randomUUID(),
        title: s.title,
        mark: s.mark,
        query: { hash: q.queryHash, semanticVersion: env1.semanticVersion, grain: "day" },
        result: {
          queryHash: q.queryHash,
          grain: "day",
          fields: env1.columns.map((c) => ({
            name: c.name,
            unit: c.unit,
            role: c.type === "time" ? "time" : "measure",
            ...(c.type === "time" ? { timeSemantics: "event_time" } : { metricId: c.name }),
          })),
        },
        completeness: env1.partialCount || env1.nullCount || env1.gaps.length ? "partial" : "complete",
        x: `${cube}.day`,
        y: [s.measure],
        layout: { x: (i % 2) * 6, y: Math.floor(i / 2) * 6, w: 6, h: 6 },
      } as unknown as VizRequest;
      const c = compileVisualization(req, metrics);
      if (!c.ok) throw new Error(`compile ${s.measure}: ${JSON.stringify(c.issues)}`);
      panels.push(c.value.panel);
      asts.push(ast);
    }
    const { workspaceId: ws } = await seedWorkspace(env, "alice", panels);
    const alice = await env.session("alice");
    void alice;
    const ctx = await loggedIn(browser, env, "alice");
    const page = await ctx.newPage();
    await page.goto(`${BASE}/w/${ws}?backend=kernel&data=semantic`);
    await page.waitForFunction(
      () => (window as unknown as { __nearesis?: { ready: boolean } }).__nearesis?.ready === true,
      null,
      { timeout: 60_000 },
    );
    await page.waitForFunction(
      (n) => document.querySelectorAll("[data-panel-state='READY']").length === n,
      panels.length,
      { timeout: 60_000 },
    );
    await page.screenshot({ path: "test-results/C14-baseline.png" });

    // (a)+(b)+(d) per panel.
    const perPanel = [];
    const gwSession: Session = { ...dummy, workspaceId: ws };
    for (const [i, p] of panels.entries()) {
      const loc = page.locator(`[data-testid='panel-${p.panelId}']`);
      const freshness = (await loc.locator("[data-testid='freshness']").textContent())!.trim();
      const completeness = (await loc.locator("[data-testid='completeness']").textContent())!.trim();
      const units = (await loc.locator("[data-testid='units']").textContent())!.trim();
      const watermark = (await loc.locator("[data-testid='watermark']").textContent())!.trim();
      const textAlt = (await loc.locator("[data-testid='text-alternative']").textContent())!;
      await loc.locator("[data-testid='provenance-toggle']").click();
      const insp = JSON.parse((await loc.locator("[data-testid='inspector']").textContent())!) as Record<
        string,
        unknown
      >;
      const re = await gateway.query(gwSession, SemanticQuery.parse(insp.ast));
      if (!re.ok) throw new Error("re-execution failed");
      const reHash = hashCanonical({ columns: re.envelope.columns, rows: re.envelope.rows });
      perPanel.push({
        panelId: p.panelId,
        title: p.title,
        freshness,
        completeness,
        units,
        watermark,
        inspector: insp,
        reHash,
      });

      expect(freshness).toMatch(/^(fresh|partial|late)$/);
      expect(completeness).toMatch(/^(complete|partial|unavailable)$/);
      const unit = Object.values(p.dataBinding.units)[0]!;
      expect(units).toContain(`=${unit}`);
      expect(watermark).toMatch(/watermark 20\d\d-\d\d-\d\dT/);
      for (const k of [
        "queryHash",
        "semanticVersion",
        "sourceSnapshotId",
        "rawManifestHash",
        "ast",
        "resultHash",
      ])
        expect(insp, k).toHaveProperty(k);
      expect(insp.queryHash).toBe(p.queryRef.hash);
      expect(insp.sourceSnapshotId).toBe(SNAPSHOT);
      expect(insp.rawManifestHash).toBe(fixtureHash(SNAPSHOT));
      expect(insp.rawManifestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(insp.sourceLabel).toBe("SYNTHETIC");
      expect(insp.semanticVersion).toBe(registry.semanticVersion);
      expect(SemanticQuery.parse(insp.ast)).toEqual(asts[i]);
      expect(re.queryHash).toBe(p.queryRef.hash);
      expect(reHash).toBe(insp.resultHash);
      expect(textAlt).toContain("Units:");
      expect(textAlt).toContain(unit);
      expect(textAlt).toContain(`Freshness: ${freshness}`);
    }
    // sourceSnapshotId / rawManifestHash are the envelope's snapshot id and fixture manifest hash when the snapshot
    // is a recorded fixture; record what the live envelope carries.
    await page.screenshot({ path: "test-results/C14-inspector.png" });

    // (c) transitions on the affected source.
    const affected = new Set(
      panels
        .filter((_, i) =>
          registry.metrics
            .find((m) => m.id === SPECS[i]!.measure)!
            .sources.some((s) => s.startsWith(`${AFFECTED_SOURCE}:`)),
        )
        .map((p) => p.panelId),
    );
    expect(affected.size).toBe(2);
    const before = await snapshot(page);
    const timeline: Array<{ t: number; label: string; states: Record<string, string> }> = [];
    const measureTransition = async (state: string) => {
      const t0 = Date.now();
      await setWatermark(orig, state);
      let seen = false;
      let last = await snapshot(page);
      while (Date.now() - t0 < 5000) {
        last = await snapshot(page);
        if (
          [...affected].every((id) => {
            const x = last.find((s) => s.id === id);
            return state === "fresh"
              ? x?.state === "READY" && x.freshness !== "late" && x.freshness !== "unavailable"
              : x?.state === "STALE" && x.freshness === state;
          })
        ) {
          seen = true;
          break;
        }
        await page.waitForTimeout(25);
      }
      const ms = Date.now() - t0;
      timeline.push({
        t: ms,
        label: state,
        states: Object.fromEntries(last.map((s) => [s.id.slice(0, 8), `${s.state}/${s.freshness}`])),
      });
      return { seen, ms, snap: last };
    };
    try {
      const late = await measureTransition("late");
      expect(late.seen).toBe(true);
      expect(late.ms).toBeLessThanOrEqual(2500); // coalescing window <= 1 s plus propagation and polling measured
      for (const s of late.snap) {
        if (affected.has(s.id)) {
          expect(s.state).toBe("STALE");
          expect(s.freshness).toBe("late");
          expect(s.stale).toContain("last good data");
          expect(s.hasChart).toBe(true);
        } else {
          const b = before.find((x) => x.id === s.id)!;
          expect(s.state).toBe(b.state);
          expect(s.freshness).toBe(b.freshness);
          expect(s.stale).toBeNull();
        }
      }
      await page.screenshot({ path: "test-results/C14-late.png" });
      const unavailable = await measureTransition("unavailable");
      expect(unavailable.seen).toBe(true);
      for (const s of unavailable.snap)
        if (affected.has(s.id)) {
          expect(s.state).toBe("STALE");
          expect(s.freshness).toBe("unavailable");
          expect(s.hasChart).toBe(true);
        } else expect(s.state).toBe("READY");
      await page.screenshot({ path: "test-results/C14-unavailable.png" });
      const textLate = await page
        .locator(`[data-testid='panel-${[...affected][0]}'] [data-testid='text-alternative']`)
        .textContent();
      expect(textLate).toContain("Freshness: unavailable");
      const recovered = await measureTransition("fresh");
      expect(recovered.seen).toBe(true);
    } finally {
      await setWatermark(orig, orig.state);
    }
    await ctx.close();

    observe({
      testId: "C14",
      observed: `4/4 panels show units, source watermark, freshness and completeness; inspector carries queryHash/AST/semanticVersion, sourceSnapshotId ${SNAPSHOT} and its raw manifest hash (${fixtureHash(SNAPSHOT).slice(0, 12)}...), and gateway re-execution reproduced all 4 result hashes; ${AFFECTED_SOURCE} fresh->late->unavailable->fresh turned exactly the ${affected.size} dependent panels STALE (last good chart kept, warning shown) in ${timeline.map((t) => `${t.label}:${t.t}ms`).join(", ")} while the other ${panels.length - affected.size} panels were unchanged; text alternatives carry units and freshness`,
      fixtureHash: hashCanonical(panels.map((p) => p.queryRef.hash)),
      evidence: { perPanel, timeline, affected: [...affected], before },
    });
  }, 300_000);
});
