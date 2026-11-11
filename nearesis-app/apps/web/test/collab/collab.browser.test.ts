/**
 * W15/W16 browser halves: the shared layout and notes page in real browser contexts against the real kernel
 * collaboration transport (HTTP, through the BFF).
 *  - two editors of tenant A (alice owner, dave analyst) in two browser contexts edit concurrently, online and
 *    offline (Playwright `setOffline`), while the canvas deletes a panel through the real canvas command;
 *  - both converge to the server state within the declared deadline, and reconciliation against the event log drops
 *    the deleted panel;
 *  - a viewer's edit is refused and not kept;
 *  - a third client of tenant B (bob, in its own workspace) receives no tenant-A ids, titles or presence, and its
 *    direct reads and writes into tenant A's rooms are refused.
 * Results are reported as browser-test results; no acceptance evidence is recorded here.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright";
import type { PanelSpec } from "@nearesis/contracts";
import { loginSession, runCmd } from "@nearesis/kernel/testing";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import {
  API,
  apiFor,
  BASE,
  type Env,
  loggedIn,
  poll,
  ready,
  seedPanels,
  startEnv,
  watch,
  WEB_DIR,
} from "../p11/harness.ts";

const OUT = `${WEB_DIR}test-results/collab`;
const DEADLINE_MS = 15_000; // as declared by the W16 backend test
type Point = { x: number; y: number };
interface CollabState {
  ready: boolean;
  online: boolean;
  buffered: number;
  refusal: string | null;
  layout: Record<string, Point>;
  notes: Record<string, string>;
  peers: Array<{ userId: string; state: Record<string, unknown> }>;
  reconcile: { documentRevision: number; dropped: string[]; panelIds: string[]; rule: string } | null;
}

let env: Env;
const panelsA: string[] = [];
const panelsB: string[] = [];
const canon = (v: Record<string, unknown>) => JSON.stringify(v, Object.keys(v).sort());

function panels(n: number, title: (i: number) => string): PanelSpec[] {
  const tpl = (loadScenario("graph").document as { panels: PanelSpec[] }).panels[0]!;
  return Array.from({ length: n }, (_, i) => ({
    ...structuredClone(tpl),
    panelId: randomUUID(),
    title: title(i),
    layout: { x: (i % 4) * 12, y: Math.floor(i / 4) * 6, w: 12, h: 6 },
  }));
}

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  env = await startEnv();
  const a = panels(12, (i) => `Panel ${i + 1} (tenant A)`);
  await seedPanels(env, "alice", env.wsA, a);
  panelsA.push(...a.map((p) => p.panelId));
  const b = panels(2, (i) => `Board ${i + 1} (tenant B)`);
  await seedPanels(env, "bob", env.wsB, b);
  panelsB.push(...b.map((p) => p.panelId));
}, 900_000);
afterAll(async () => {
  await env?.close();
});

const st = (p: Page) => p.evaluate(() => (window as unknown as { __collab: CollabState }).__collab);

async function openCollab(ctx: BrowserContext, ws: string) {
  const w = await watch(ctx);
  await w.page.goto(`${BASE}/w/${ws}/collab`);
  await ready(w.page, "__collab", 120_000);
  return w;
}
async function move(p: Page, id: string, at: Point) {
  const row = p.getByTestId(`collab-row-${id}`);
  await row.getByTestId("collab-x").fill(String(at.x));
  await row.getByTestId("collab-y").fill(String(at.y));
  await row.getByTestId("collab-set").click();
}

describe("shared layout (W15/W16 browser halves)", () => {
  it("two editors converge online and after offline edits; the canvas delete wins; viewer refused; tenant B sees nothing", async () => {
    const [p1, p2, p3, , p5, , p7] = panelsA as [string, string, string, string, string, string, string];
    const ctxA = await loggedIn(env, "alice");
    const ctxB = await loggedIn(env, "dave");
    const ctxV = await loggedIn(env, "carol");
    const ctxT = await loggedIn(env, "bob");

    // Third tenant: capture every response body its page receives, from the first request on.
    const T = await watch(ctxT);
    const captured: string[] = [];
    T.page.on("response", (r) => {
      const ct = r.headers()["content-type"] ?? "";
      if (/json|text\/html|event-stream/.test(ct))
        void r.text().then(
          (t) => captured.push(t),
          () => undefined,
        );
    });
    await T.page.goto(`${BASE}/w/${env.wsB}/collab`);
    await ready(T.page, "__collab", 120_000);
    await T.page.getByTestId("collab-place-all").click();

    const A = await openCollab(ctxA, env.wsA);
    const B = await openCollab(ctxB, env.wsA);

    // Seed the CRDT layout from the canvas panels (as the first client would).
    await A.page.getByTestId("collab-place-all").click();
    await poll(
      async () => Object.keys((await st(B.page)).layout).length === 12 && (await st(A.page)).buffered === 0,
      DEADLINE_MS,
      "seeded layout on both clients",
    );

    // Phase 1 (online, concurrent): both move the same two panels differently.
    await Promise.all([
      (async () => {
        await move(A.page, p1, { x: 10, y: 0 });
        await move(A.page, p2, { x: 0, y: 0 });
      })(),
      (async () => {
        await move(B.page, p1, { x: 20, y: 20 });
        await move(B.page, p2, { x: 30, y: 20 });
      })(),
    ]);
    await poll(
      async () => {
        const [a, b] = [await st(A.page), await st(B.page)];
        return a.buffered === 0 && b.buffered === 0 && canon(a.layout) === canon(b.layout);
      },
      DEADLINE_MS,
      "online convergence",
    );
    const online = await st(A.page);
    expect([10, 20]).toContain(online.layout[p1]!.x);
    await A.page.screenshot({ path: `${OUT}/01-online-converged.png`, fullPage: true });

    // Presence: A works on panel 2; B sees it. Presence never leaves the workspace.
    await A.page.getByTestId(`collab-row-${p2}`).getByTestId("collab-x").focus();
    await poll(
      async () =>
        /editing Panel 2 \(tenant A\)/.test((await B.page.getByTestId("collab-peers").textContent()) ?? ""),
      DEADLINE_MS,
      "presence on B",
    );

    // Phase 2 (offline): conflicting edits neither has seen; the canvas deletes panel 5 meanwhile.
    await Promise.all([ctxA.setOffline(true), ctxB.setOffline(true)]);
    await poll(
      async () => !(await st(A.page)).online && !(await st(B.page)).online,
      DEADLINE_MS,
      "offline state",
    );
    await move(A.page, p3, { x: 100, y: 5 });
    await A.page.getByTestId(`collab-row-${p7}`).getByTestId("collab-unplace").click();
    await move(A.page, p5, { x: 77, y: 77 });
    await move(B.page, p3, { x: -100, y: 5 });
    await move(B.page, p7, { x: 55, y: 55 });
    await move(B.page, p5, { x: 88, y: 88 });
    expect((await st(A.page)).buffered).toBe(3);
    expect((await st(B.page)).buffered).toBe(3);
    await expect(A.page.getByTestId("collab-offline").isVisible()).resolves.toBe(true);
    await A.page.screenshot({ path: `${OUT}/02-offline-buffered.png`, fullPage: true });

    const s = await loginSession(env.kernel, env.subjects.alice);
    const ws = await env.kernel.workspaces.get(s, env.wsA);
    const doc = await env.kernel.canvas.get(s, env.wsA);
    await runCmd(
      env.kernel,
      s,
      env.wsA,
      "canvas.apply_patch",
      {
        schemaVersion: 1,
        type: "workspace.patch",
        operationId: randomUUID(),
        expectedRevision: doc.documentRevision,
        operations: [{ op: "removePanel", panelId: p5 }],
      },
      ws.version,
    );
    const canvasRev = (await env.kernel.canvas.get(s, env.wsA)).documentRevision;

    // Reconnect both at the same time; both reach byte-equal layout within the deadline.
    await Promise.all([ctxA.setOffline(false), ctxB.setOffline(false)]);
    let la!: CollabState;
    let lb!: CollabState;
    await poll(
      async () => {
        [la, lb] = [await st(A.page), await st(B.page)];
        return (
          la.online &&
          lb.online &&
          la.buffered === 0 &&
          lb.buffered === 0 &&
          canon(la.layout) === canon(lb.layout)
        );
      },
      DEADLINE_MS,
      "convergence after reconnect",
    );
    const alice = await apiFor(env, "alice", env.wsA);
    const server = (await (
      await fetch(`${API}/v1/workspaces/${env.wsA}/collab/layout/state`, {
        headers: { authorization: `Bearer ${alice.token}` },
      })
    ).json()) as { decoded: Record<string, Point> };
    expect(canon(server.decoded)).toBe(canon(la.layout));
    expect([100, -100]).toContain(la.layout[p3]!.x); // opposite moves resolve to one write, identically
    expect(la.layout[p7]?.x).toBe(55); // concurrent unplace versus move: the move survives (documented rule)

    // Reconciliation against the event log (runs automatically after reconnect): panel 5 is dropped, not revived.
    await poll(
      async () =>
        (await st(A.page)).reconcile?.documentRevision === canvasRev && (await st(B.page)).reconcile !== null,
      DEADLINE_MS,
      "reconciliation after reconnect",
    );
    const rec = (await st(A.page)).reconcile!;
    expect(rec.dropped).toContain(p5);
    expect(rec.panelIds).not.toContain(p5);
    expect(rec.rule).toMatch(/event log/);
    await expect(A.page.getByTestId("rec-dropped").textContent()).resolves.toContain(p5);
    await poll(
      async () => (await A.page.getByTestId(`collab-row-${p5}`).count()) === 0,
      DEADLINE_MS,
      "row removed",
    );
    await A.page.getByTestId("collab-reconcile-result").scrollIntoViewIfNeeded();
    await A.page.screenshot({ path: `${OUT}/03-reconciled.png`, fullPage: true });

    // Notes converge too.
    await A.page.getByTestId("collab-note").fill("hello from A");
    await poll(async () => (await st(B.page)).notes.shared === "hello from A", DEADLINE_MS, "note on B");
    await B.page.getByTestId("collab-note").press("End");
    await B.page.getByTestId("collab-note").pressSequentially(" and B");
    await poll(
      async () => (await st(A.page)).notes.shared === "hello from A and B",
      DEADLINE_MS,
      "note on A",
    );

    // Viewer: the edit is refused by the server and not kept on screen.
    const V = await openCollab(ctxV, env.wsA);
    const before = (await st(V.page)).layout[p1];
    await move(V.page, p1, { x: 999, y: 999 });
    await V.page.getByTestId("collab-refusal").waitFor({ timeout: DEADLINE_MS });
    await expect(V.page.getByTestId("collab-refusal").textContent()).resolves.toMatch(/INSUFFICIENT_ROLE/);
    await poll(
      async () => (await st(V.page)).layout[p1]?.x === before?.x,
      DEADLINE_MS,
      "viewer edit discarded",
    );
    const after = (await (
      await fetch(`${API}/v1/workspaces/${env.wsA}/collab/layout/state`, {
        headers: { authorization: `Bearer ${alice.token}` },
      })
    ).json()) as { decoded: Record<string, Point> };
    expect(after.decoded[p1]).toEqual(la.layout[p1]);
    await V.page.screenshot({ path: `${OUT}/04-viewer-refused.png`, fullPage: true });

    // Third tenant: its own room works, and nothing from tenant A reached it, across offline/reconnect.
    await poll(
      async () => Object.keys((await st(T.page)).layout).length === panelsB.length,
      DEADLINE_MS,
      "tenant B layout",
    );
    const probes = await T.page.evaluate(async (wsA) => {
      const base = `/api/k/workspaces/${wsA}/collab`;
      const out: number[] = [];
      out.push((await fetch(`${base}/layout/state`)).status);
      out.push((await fetch(`${base}/layout/presence`)).status);
      out.push((await fetch(`${base}/layout/reconcile`)).status);
      out.push(
        (
          await fetch(`${base}/layout/presence?clientId=x`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ state: { focus: "probe" } }),
          })
        ).status,
      );
      out.push(
        (
          await fetch(`${base}/layout/updates`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ update: "AAA=" }),
          })
        ).status,
      );
      return out;
    }, env.wsA);
    expect(probes).toEqual([404, 404, 404, 404, 404]);
    const tState = await st(T.page);
    const everything =
      captured.join("\n") + JSON.stringify(tState) + ((await T.page.textContent("body")) ?? "");
    for (const id of panelsA) expect(everything).not.toContain(id);
    expect(everything).not.toContain("tenant A");
    expect(everything).not.toContain(env.wsA);
    expect(tState.peers.every((p) => !JSON.stringify(p.state).includes("Panel"))).toBe(true);
    await T.page.screenshot({ path: `${OUT}/05-tenant-b.png`, fullPage: true });

    // No CSP violations or page errors on any client.
    for (const w of [A, B, V, T]) {
      expect(await w.csp()).toEqual([]);
      expect(w.errors).toEqual([]);
    }
    for (const c of [ctxA, ctxB, ctxV, ctxT]) await c.close();
  }, 600_000);
});
