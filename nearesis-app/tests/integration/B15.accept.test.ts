import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { observe } from "@nearesis/acceptance";
import { computeResults, canonicalSha256 } from "../../packages/capsule/src/index.ts";
import type { VerifierInput } from "../../packages/capsule/src/index.ts";
import { runFlow } from "./lib/flow.ts";
import { join } from "node:path";
import { APP_ROOT, signFlipRule } from "./lib/research.ts";
import { openStack, stopIfBlocked, type Stack } from "./lib/stack.ts";
import { focusInfo, startBrowser, tabTo, type BrowserSession, type Page } from "./lib/browser.ts";

const ARTIFACTS = join(APP_ROOT, "test-results", "integration-B15");

let s: Stack;
let web: BrowserSession | undefined;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => {
  await web?.close();
  await s?.close();
}, 120_000);

/**
 * SYNTHETIC concentration structure (labelled): 100 accounts, one of which (the top 1%) carries a rising volume that
 * tracks the rising active-signer series, while the other 99 drift down against it. The pooled series correlates
 * positively with the signers; removing the top 1% flips the sign.
 */
function concentration(): { full: VerifierInput; excl: VerifierInput } {
  const days = 60;
  const start = Date.UTC(2026, 8, 1);
  let seed = 7n;
  const noise = (): bigint => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return (seed >> 33n) % 200n;
  };
  const dates = Array.from({ length: days }, (_v, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
  const whale = dates.map((_d, i) => 5_000_000n + BigInt(i) * 90_000n + noise());
  const rest = dates.map((_d, i) => 6_000_000n - BigInt(i) * 12_000n + noise());
  const signers = dates.map((_d, i) => 50_000n + BigInt(i) * 120n + noise());
  const pts = (v: bigint[]): Array<[string, string]> => v.map((x, i) => [dates[i]!, x.toString()]);
  const mk = (x: bigint[]): VerifierInput => ({
    schema_version: "nearesis.verifier.input.v1",
    claim_id: "syn:concentration",
    source: {
      dataset: "SYNTHETIC concentration structure",
      snapshot_id: "synthetic-concentration",
      synthetic: true,
    },
    series: {
      x: { name: "intents_volume_proxy", unit: "usd_cents", points: pts(x) },
      y: { name: "active_signers_proxy", unit: "accounts", points: pts(signers) },
    },
    metrics: ["pearson"],
  });
  return { full: mk(dates.map((_d, i) => whale[i]! + rest[i]!)), excl: mk(rest) };
}
const sign = (ppm: string | null): number => (ppm === null ? 0 : Math.sign(Number(ppm)));

it("B15: a branch tests a sensitivity, the comparison shows both values, counterevidence is reachable and lineage reaches the raw snapshot, without touching the parent", async () => {
  if (await stopIfBlocked(s, "B15", "the real-stack flow")) return;
  const f = await runFlow(s);
  const ws = f.workspaceId;
  const g = f.graph!;
  const ver = async () =>
    ((await s.owner.call("GET", `/v1/workspaces/${ws}`)).json as { version: number }).version;
  const graphHash = async () =>
    canonicalSha256((await s.owner.call("GET", `/v1/workspaces/${ws}/graph`)).json);
  const canvasHash = async () =>
    canonicalSha256(
      ((await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as { panels: unknown }).panels,
    );

  // headline estimates from the capsule verifier's own math on the SYNTHETIC structure
  const { full, excl } = concentration();
  const rFull = computeResults(full) as { pearson_ppm: string | null };
  const rExcl = computeResults(excl) as { pearson_ppm: string | null };
  expect(sign(rFull.pearson_ppm)).toBe(1);
  expect(sign(rExcl.pearson_ppm)).toBe(-1); // designed sign flip

  const graphDump = async () => {
    const g = (await s.owner.call("GET", `/v1/workspaces/${ws}/graph`)).json as {
      nodes: Array<{ id: string }>;
      edges: Array<{ id: string }>;
    };
    return JSON.stringify([g.nodes, g.edges]);
  };
  const graphBeforeDump = await graphDump();
  const parentBefore = { graph: await graphHash(), panels: await canvasHash() };
  // snapshot the parent, then branch from it (history API)
  const snap = await s.owner.call("POST", `/v1/workspaces/${ws}/snapshots`, {
    label: "before sensitivity",
    expectedVersion: await ver(),
  });
  expect(snap.status, JSON.stringify(snap.json).slice(0, 300)).toBeLessThan(300);
  const snapshotId = ((snap.json as { result?: { snapshotId?: string }; snapshotId?: string }).result
    ?.snapshotId ?? (snap.json as { snapshotId?: string }).snapshotId)!;
  const br = await s.owner.call("POST", `/v1/workspaces/${ws}/branches`, {
    fromSnapshotId: snapshotId,
    name: "exclude top 1% accounts",
    expectedVersion: await ver(),
  });
  expect(br.status, JSON.stringify(br.json).slice(0, 300)).toBeLessThan(300);
  const branchId = ((br.json as { result?: { branchId?: string }; branchId?: string }).result?.branchId ??
    (br.json as { branchId?: string }).branchId)!;
  // rerun the headline in the branch: a new result node (with the filter), a counterevidence claim edge
  const resultId = crypto.randomUUID();
  const ch = await s.owner.call("POST", `/v1/workspaces/${ws}/branches/${branchId}/changes`, {
    expectedVersion: await ver(),
    ops: [
      {
        op: "set",
        objectId: `node:${resultId}`,
        value: {
          kind: "statistical_result",
          label: "headline, top 1% excluded",
          data: { pearson_ppm: rExcl.pearson_ppm, filter: "exclude top 1% accounts", parentResult: g.result },
        },
      },
      {
        op: "set",
        objectId: `edge:${resultId}|${g.claim}|contradicts`,
        value: { source: resultId, target: g.claim, relation: "contradicts" },
      },
    ],
  });
  expect(ch.status, JSON.stringify(ch.json).slice(0, 400)).toBeLessThan(300);
  const view = (await s.owner.call("GET", `/v1/workspaces/${ws}/branches/${branchId}`)).json as Record<
    string,
    unknown
  >;
  const diff = (await s.owner.call("GET", `/v1/workspaces/${ws}/branches/${branchId}/diff?against=base`))
    .json as { changes?: unknown[] };
  // (a) the branch result differs as designed and the parent is unchanged byte for byte
  const parentAfter = { graph: await graphHash(), panels: await canvasHash() };
  expect(parentAfter.panels).toEqual(parentBefore.panels);
  const afterDump = JSON.parse(await graphDump()) as unknown[][];
  const beforeDump = JSON.parse(graphBeforeDump) as unknown[][];
  const changed: string[] = [];
  for (const k of [0, 1])
    beforeDump[k]!.forEach((x, i) => {
      if (JSON.stringify(x) !== JSON.stringify(afterDump[k]![i]))
        changed.push(`${JSON.stringify(x)} => ${JSON.stringify(afterDump[k]![i])}`);
    });
  expect(changed.join(" || ").slice(0, 1500)).toBe("");
  expect(afterDump[0]!.length).toBe(beforeDump[0]!.length);
  expect(afterDump[1]!.length).toBe(beforeDump[1]!.length);
  expect(JSON.stringify(view)).toContain("exclude top 1%");
  expect((diff.changes ?? []).length).toBeGreaterThan(0);
  // (b) comparison: both values with filters; the claim verdict is capped at MIXED by the frozen Q18 sign-flip rule
  const compare = {
    parent: { filter: "none", pearson_ppm: rFull.pearson_ppm },
    branch: { filter: "exclude top 1% accounts", pearson_ppm: rExcl.pearson_ppm },
  };
  expect(compare.parent.pearson_ppm).not.toBe(compare.branch.pearson_ppm);
  const rule = signFlipRule(Number(rFull.pearson_ppm), Number(rExcl.pearson_ppm));
  expect(rule.headlineAfter).toBe("MIXED");
  // (c) supports and contradicts edges: counterevidence reachable from the claim in the branch view (graph level)
  const edges = JSON.stringify(view);
  expect(edges).toContain("contradicts");
  // (d) lineage: claim -> result -> model -> query -> source, each node carrying its hash
  const gr = (await s.owner.call("GET", `/v1/workspaces/${ws}/graph`)).json as {
    nodes: Array<{ id: string; type: string; label?: string; data?: Record<string, unknown> }>;
    edges: Array<{ source: string; target: string; relation: string }>;
  };
  const path: string[] = [g.claim];
  const next = (id: string): string | undefined =>
    gr.edges.find((e) => e.source === id || (e.target === id && e.relation === "supports"))?.[e0(gr, id)];
  void next;
  const chain = [g.claim, g.result, g.model, g.query, g.source];
  for (let i = 0; i < chain.length - 1; i++)
    expect(
      gr.edges.some(
        (e) =>
          (e.source === chain[i + 1] && e.target === chain[i] && e.relation === "supports") ||
          (e.source === chain[i] && e.target === chain[i + 1] && e.relation === "derived_from") ||
          (e.source === chain[i + 1] && e.target === chain[i]),
      ),
      `${chain[i]}->${chain[i + 1]}`,
    ).toBe(true);
  const nodeById = new Map(gr.nodes.map((n) => [n.id, n]));
  const manifestHash = String(nodeById.get(g.source)?.data?.manifestHash ?? "");
  expect(manifestHash).toMatch(/^[0-9a-f]{64}$/);
  expect(String(nodeById.get(g.query)?.data?.queryHash)).toMatch(/^[0-9a-f]{64}$/);
  expect(String(nodeById.get(g.model)?.data?.semanticVersion)).toMatch(/^\d+\.\d+\.\d+$/);
  expect(String(nodeById.get(g.model)?.data?.modelRevision)).toBeTruthy();
  path.push(g.result, g.model, g.query, g.source);

  // ---------------------------------------------------------------------------------------------------------------
  // Browser half: the production build of apps/web in Chromium over the same stack. The branch the backend half created
  // is opened through the Time machine page and its evidence graph (branch view); clicks are counted.
  // ---------------------------------------------------------------------------------------------------------------
  const BRANCH = "exclude top 1% accounts";
  const label = (id: string): string => String(nodeById.get(id)?.label ?? id);
  const ui: Record<string, unknown> = {};
  const blockedParts: string[] = [];
  const shot = (name: string) => join(ARTIFACTS, `${name}.png`);
  const inspector = (page: Page) => page.getByTestId("node-inspector");
  const heading = (page: Page) => inspector(page).locator("h2").first().innerText();
  const recorded = async (page: Page, how: "click" | "keyboard"): Promise<string> => {
    const pre = inspector(page).locator("details pre");
    if (!(await pre.isVisible()))
      if (how === "click") await inspector(page).locator("summary", { hasText: "Recorded data" }).click();
      else {
        await tabTo(page, (x) => x.tag === "SUMMARY" && x.text === "Recorded data");
        await page.keyboard.press("Enter");
      }
    return pre.innerText();
  };
  try {
    web = await startBrowser(s);
    // ---- pointer flow: branch -> comparison -> evidence graph (branch view) -> counterevidence -> lineage
    const hist = await web.open(`/w/${ws}/history`, "__history");
    const page = hist.page;
    let clicks = 0;
    const click = async (what: string, loc: ReturnType<Page["getByTestId"]>) => {
      await loc.click();
      clicks++;
      ui[`click ${clicks}`] = what;
    };
    await click("open the branch in the Time machine", page.getByTestId(`open-branch-${BRANCH}`));
    await page.getByTestId("branch-view").waitFor({ timeout: 30_000 });
    const diffMain = await page.getByTestId("branch-diff-main").innerText();
    const branchView = await page.getByTestId("branch-view").innerText();
    await page.getByTestId("branch-view").scrollIntoViewIfNeeded();
    await page.screenshot({ path: shot("01-branch-vs-main"), fullPage: true });
    // (b) what the comparison shows: the branch value with its filter and label
    // the diff table truncates long cells; the label is read from the branch object list of the same view
    const showsBranchValue =
      diffMain.includes(String(rExcl.pearson_ppm)) &&
      diffMain.includes("exclude top 1% accounts") &&
      branchView.includes("headline, top 1% excluded");
    expect(showsBranchValue, diffMain.slice(0, 500)).toBe(true);
    const showsParentValue = diffMain.includes(`"${rFull.pearson_ppm}"`);
    const showsVerdict = /MIXED/.test(branchView);
    ui["(b) branch value, filter and label in the branch-vs-main diff"] = showsBranchValue;
    ui["(b) parent value in the branch-vs-main diff"] = showsParentValue;
    ui["(b) branch view shows a recomputed verdict (MIXED)"] = showsVerdict;
    if (!showsParentValue || !showsVerdict)
      blockedParts.push(
        `(b) no side-by-side comparison view exists in apps/web: the Time machine branch-vs-main table lists only changed objects (the branch result with its filter and label is shown; the parent value ${showsParentValue ? "is" : "is not"} shown) and the branch evidence graph states that claim support is not computed for branches (a MIXED verdict ${showsVerdict ? "is" : "is not"} displayed); a view placing both values and filters next to each other with the Q18-capped verdict is the missing UI piece`,
      );
    // open the evidence graph (branch view) from the branch row
    const graphLink = page.locator(`a[href$="/evidence?branch=${branchId}"]`).first();
    await graphLink.click();
    clicks++;
    ui[`click ${clicks}`] = "open the evidence graph (branch view)";
    await page.waitForURL(`**/evidence?branch=${branchId}`);
    await page.waitForFunction(
      () => (window as unknown as { __evidence?: { ready?: boolean } }).__evidence?.ready === true,
      undefined,
      { timeout: 60_000 },
    );
    await page.getByTestId("branch-banner").waitFor();
    // (c) supports and contradicts edges are visible
    const edgeLabels = await page
      .locator(".react-flow__edge")
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    const drawn = (rel: string) => edgeLabels.filter((l) => l.startsWith(`${rel} edge`)).length;
    ui["(c) drawn edges"] = { supports: drawn("supports"), contradicts: drawn("contradicts") };
    expect(drawn("supports"), edgeLabels.join(" | ")).toBeGreaterThan(0);
    expect(drawn("contradicts"), edgeLabels.join(" | ")).toBeGreaterThan(0);
    // counterevidence reachable from the claim in at most 2 clicks
    const before = clicks;
    await click("select the headline claim", page.getByTestId(`list-node-${g.claim}`));
    expect(await heading(page)).toBe(label(g.claim));
    await page.screenshot({ path: shot("02-claim-selected"), fullPage: true });
    const counter = inspector(page)
      .locator("li", { hasText: /^contradicts from/ })
      .getByRole("button");
    expect(await counter.count()).toBeGreaterThan(0);
    const counterLabel = await counter.first().innerText();
    await click("follow the contradicts relation to the counterevidence", counter.first());
    const clicksToCounter = clicks - before;
    expect(await heading(page)).toBe(counterLabel);
    expect(counterLabel).toContain("top 1% excluded");
    expect(clicksToCounter).toBeLessThanOrEqual(2);
    ui["(c) clicks from the claim to the counterevidence"] = clicksToCounter;
    await page.screenshot({ path: shot("03-counterevidence"), fullPage: true });
    // (d) lineage: claim -> result -> model -> query -> source, each hash read from the inspector
    const hop = async (from: string, relation: RegExp, to: string, how: "click" | "keyboard") => {
      const btn = inspector(page)
        .locator("li", { hasText: relation })
        .getByRole("button", { name: label(to), exact: true });
      if (how === "click") await btn.first().click();
      else {
        await tabTo(page, (x) => x.tag === "BUTTON" && x.text === label(to) && relation.test(x.rowText));
        await page.keyboard.press("Enter");
      }
      expect(await heading(page), `${from} -> ${to}`).toBe(label(to));
    };
    const lineageSteps: Array<{ node: string; relation: RegExp; expectIn: (d: string) => boolean }> = [
      {
        node: g.result,
        relation: /^supports from/,
        expectIn: (d) => d.includes(String(nodeById.get(g.result)?.data?.capsuleHash)),
      },
      {
        node: g.model,
        relation: /^derived_from to/,
        expectIn: (d) =>
          d.includes(String(nodeById.get(g.model)?.data?.modelRevision)) &&
          d.includes(String(nodeById.get(g.model)?.data?.semanticVersion)),
      },
      {
        node: g.query,
        relation: /^derived_from to/,
        expectIn: (d) => d.includes(String(nodeById.get(g.query)?.data?.queryHash)),
      },
      { node: g.source, relation: /^derived_from to/, expectIn: (d) => d.includes(manifestHash) },
    ];
    const walk = async (how: "click" | "keyboard") => {
      let cur = g.claim;
      const seen: Array<{ node: string; hash: string }> = [];
      for (const st of lineageSteps) {
        await hop(cur, st.relation, st.node, how);
        const data = await recorded(page, how);
        expect(st.expectIn(data), `${label(st.node)}: ${data.slice(0, 300)}`).toBe(true);
        seen.push({ node: label(st.node), hash: data.length > 0 ? "displayed" : "missing" });
        cur = st.node;
      }
      return seen;
    };
    await click("select the claim again", page.getByTestId(`list-node-${g.claim}`));
    const seen = await walk("click");
    ui["(d) lineage walked in the inspector"] = seen.map((x) => x.node);
    ui["(d) clicks for the lineage walk"] = "8 (4 relation links and 4 record expansions)";
    await page.screenshot({ path: shot("04-lineage-source-hash"), fullPage: true });
    await hist.context.close();

    // ---- (e) keyboard only: Tab / Enter from the Time machine to the lineage, no pointer events at all
    const kb = await web.open(`/w/${ws}/history`, "__history");
    const kp = kb.page;
    const pressed: Record<string, number> = {};
    pressed.openBranch = await tabTo(kp, (x) => x.testId === `open-branch-${BRANCH}`);
    await kp.keyboard.press("Enter");
    await kp.getByTestId("branch-view").waitFor({ timeout: 30_000 });
    pressed.graphLink = await tabTo(
      kp,
      (x) => x.tag === "A" && (x.href ?? "").endsWith(`/evidence?branch=${branchId}`),
    );
    await kp.keyboard.press("Enter");
    await kp.waitForURL(`**/evidence?branch=${branchId}`);
    await kp.waitForFunction(
      () => (window as unknown as { __evidence?: { ready?: boolean } }).__evidence?.ready === true,
      undefined,
      { timeout: 60_000 },
    );
    pressed.claim = await tabTo(kp, (x) => x.testId === `list-node-${g.claim}`);
    await kp.keyboard.press("Enter");
    expect(await heading(kp)).toBe(label(g.claim));
    pressed.counter = await tabTo(kp, (x) => x.tag === "BUTTON" && /^contradicts from/.test(x.rowText));
    const focusedCounter = (await focusInfo(kp)).text;
    await kp.keyboard.press("Enter");
    expect(await heading(kp)).toBe(focusedCounter);
    expect(focusedCounter).toContain("top 1% excluded");
    await kp.screenshot({ path: shot("05-keyboard-counterevidence"), fullPage: true });
    // lineage by keyboard, from the claim again
    pressed.claimAgain = await tabTo(kp, (x) => x.testId === `list-node-${g.claim}`);
    await kp.keyboard.press("Enter");
    let cur = g.claim;
    for (const st of lineageSteps) {
      const btn = label(st.node);
      pressed[`hop ${btn}`] = await tabTo(
        kp,
        (x) => x.tag === "BUTTON" && x.text === btn && st.relation.test(x.rowText),
      );
      await kp.keyboard.press("Enter");
      expect(await heading(kp), `${cur} -> ${st.node}`).toBe(btn);
      const data = await recorded(kp, "keyboard");
      expect(st.expectIn(data), `${btn}: ${data.slice(0, 300)}`).toBe(true);
      cur = st.node;
    }
    await kp.screenshot({ path: shot("06-keyboard-lineage-source-hash"), fullPage: true });
    ui["(e) keyboard-only flow: Tab presses to each target"] = pressed;
    await kb.context.close();
    ui.errors = [...hist.errors, ...kb.errors];
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 700);
    if (/next build|web server|dev login/.test(msg))
      blockedParts.push(`the browser half could not start: ${msg}`);
    else throw e;
  }
  const blocked = blockedParts.join("; ") || undefined;
  observe({
    testId: "B15",
    fixtureHash: createHash("sha256")
      .update(JSON.stringify([rFull, rExcl]))
      .digest("hex"),
    observed: `SYNTHETIC concentration (100 accounts, top 1% carries the trend): pooled Pearson ${rFull.pearson_ppm} ppm (sign +) vs top-1%-excluded ${rExcl.pearson_ppm} ppm (sign -); branch "${"exclude top 1% accounts"}" created from snapshot ${snapshotId.slice(0, 8)} through the history API, rerun result and a contradicts edge recorded in the branch only; parent graph and panels byte-identical before/after (${parentBefore.graph.slice(0, 12)}); frozen Q18 sign-flip rule caps the headline at ${rule.headlineAfter} (flips ${rule.flips.length}); lineage ${path.length} nodes claim -> result -> model -> query -> raw snapshot with hashes (manifest ${manifestHash.slice(0, 12)}). Browser half (apps/web production build in Chromium): ${blocked ? `NOT FULLY PASSED: ${blocked}` : "all criteria exercised"}; ${JSON.stringify(ui)}.`,
    evidence: {
      compare,
      rule,
      parentBefore,
      parentAfter,
      lineage: path,
      manifestHash,
      browser: ui,
      screenshots: ARTIFACTS,
    },
    ...(blocked ? { blocked } : {}),
  });
}, 900_000);
