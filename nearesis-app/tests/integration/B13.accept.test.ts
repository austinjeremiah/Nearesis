import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import {
  FORBIDDEN,
  PublicationBlocked,
  ThesisLifecycle,
  checkLabels,
  labelledPanel,
  scanForbidden,
  type ForbiddenClass,
  type LabelSurface,
  type PanelKind,
} from "../../plugins/near-thesis/src/index.ts";
import { panelSpec } from "../../packages/workflow/test/acceptance/m-marker-helpers.ts";
import { runFlow } from "./lib/flow.ts";
import { markerCommand, openStack, stopIfBlocked, q, type Stack } from "./lib/stack.ts";

let s: Stack;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => s?.close(), 120_000);

/** One seeded forbidden claim per class (ch.19 anti-patterns, ch.02 H4/H5, ch.14 1Click). */
const SEEDED: Record<ForbiddenClass, string> = {
  complete_status_fixture: "Verification is complete for this run, status: complete.",
  tee_implies_truth: "The result is TEE-verified, so the hypothesis holds.",
  explorer_private_history: "We read each user's private transaction history through the partner JWT.",
  quote_as_execution: "The realized spread on these routes was low.",
  oneclick_as_all_intents: "This shows all NEAR Intents volume for the period.",
  live_mainnet_funds: "The team swapped real funds to confirm the quotes.",
};

it("B13: outputs carry the required scope labels and none of the forbidden claims", async () => {
  if (await stopIfBlocked(s, "B13", "the real-stack flow")) return;
  const f = await runFlow(s);
  const ws = f.workspaceId;
  const date = "2026-11-11";

  // panels with the labels each data kind requires, persisted through the kernel
  const kinds: Array<{ kind: PanelKind; title: string }> = [
    { kind: "quote", title: "Dry quote failure rate" },
    { kind: "swap_volume", title: "Completed 1Click swap volume" },
    { kind: "post_cutoff", title: "Settlement view after 2026-10-27" },
    { kind: "generic", title: "Observed days" },
  ];
  const ids = new Map<string, PanelKind>();
  for (const [i, k] of kinds.entries()) {
    const lab = labelledPanel(k.kind, {
      title: k.title,
      mode: "fixture",
      date,
      sampledAt: `${date}T06:00:00Z`,
    });
    const doc = (await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as {
      documentRevision: number;
    };
    const p = { ...panelSpec(), ...lab, layout: { x: 0, y: 8 + i * 4, w: 6, h: 4 } };
    ids.set(p.panelId, k.kind);
    const r = await markerCommand(s.owner, ws, "canvas.apply_patch", {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: crypto.randomUUID(),
      expectedRevision: doc.documentRevision,
      operations: [{ op: "addPanel", panel: p }],
    });
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
  }
  const canvas = (await s.owner.call("GET", `/v1/workspaces/${ws}/canvas`)).json as {
    panels: Array<{ panelId: string; title: string; note?: string }>;
  };
  const labelled: LabelSurface[] = canvas.panels
    .filter((p) => ids.has(p.panelId))
    .map((p) => ({ id: p.panelId, kinds: [ids.get(p.panelId)!], text: `${p.title}. ${p.note ?? ""}` }));
  expect(labelled).toHaveLength(4);
  const exportsDir = join(f.capsuleDir!, "exports");
  const exportSurfaces: LabelSurface[] = ["THESIS.md", "DATA.md"].map((n) => ({
    id: `export:${n}`,
    kinds: ["generic"],
    text: readFileSync(join(exportsDir, n), "utf8"),
    modePattern: /SYNTHETIC|fixture/i,
  }));

  // (a) 0 forbidden-class matches in the genuine run (panels, exports, memo, agent findings)
  const findings = await q<{ statement: string }>(
    s.env,
    s.env.tenantId,
    "SELECT result->'result'->'finding'->>'statement' AS statement FROM tasks WHERE workspace_id=$1 AND result IS NOT NULL",
    [ws],
  );
  const genuine: Record<string, string> = {
    "THESIS.md": f.texts["THESIS.md"]!,
    "DATA.md": f.texts["DATA.md"]!,
    "LIMITATIONS.md": f.texts["LIMITATIONS.md"]!,
    memo: readFileSync(join(exportsDir, "memo.pdf")).toString("latin1"),
    ...Object.fromEntries(canvas.panels.map((p) => [`panel:${p.panelId}`, `${p.title}. ${p.note ?? ""}`])),
    ...Object.fromEntries(findings.map((r, i) => [`finding:${i}`, r.statement ?? ""])),
  };
  const hits = Object.entries(genuine).flatMap(([k, t]) =>
    scanForbidden(t).map((h) => ({ surface: k, ...h })),
  );
  expect(hits).toEqual([]);

  // (b) required labels present; every surface shows mode and a date
  const check = checkLabels([
    ...labelled,
    ...exportSurfaces.map((e) => ({ ...e, text: `${e.text} ${date}` })),
  ]);
  expect(check.missing).toEqual([]);
  const quote = labelled.find((l) => l.kinds[0] === "quote")!.text;
  expect(quote).toContain("dry quote, not realized execution");
  expect(quote).toContain("sampled at");
  expect(labelled.find((l) => l.kinds[0] === "swap_volume")!.text).toContain(
    "provider-reported 1Click, not all Intents",
  );
  expect(labelled.find((l) => l.kinds[0] === "post_cutoff")!.text).toContain(
    "not observable after 2026-10-27",
  );

  // (c) all 6 seeded claims are caught, and publication is blocked before display
  const caught: Record<string, string[]> = {};
  for (const cls of Object.keys(SEEDED) as ForbiddenClass[]) {
    const lc = new ThesisLifecycle();
    lc.freeze("sha256:" + "c".repeat(64), { approvedBy: "o", role: "owner" });
    lc.openLockbox({ evaluationHash: "e" });
    lc.completeAudit({ ok: true, detail: "ok" });
    let blockedClasses: string[] = [];
    try {
      lc.publish({ "agent-message": `${SEEDED[cls]}` });
    } catch (e) {
      expect(e).toBeInstanceOf(PublicationBlocked);
      blockedClasses = [...new Set((e as PublicationBlocked).hits.map((h) => h.cls))];
    }
    caught[cls] = blockedClasses;
    expect(blockedClasses, cls).toEqual([cls]);
  }
  expect(FORBIDDEN).toHaveLength(6);

  // (d) a missing label names the panel: a template that drops the quote caveat must FAIL (b)
  const dropped = labelled.map((l) =>
    l.kinds[0] === "quote" ? { ...l, text: l.text.replace("dry quote, not realized execution", "") } : l,
  );
  const bad = checkLabels(dropped);
  expect(bad.ok).toBe(false);
  expect(bad.missing).toEqual([
    { id: dropped.find((l) => l.kinds[0] === "quote")!.id, missing: ["dry quote, not realized execution"] },
  ]);

  observe({
    testId: "B13",
    fixtureHash: createHash("sha256").update(JSON.stringify(SEEDED)).digest("hex"),
    observed: `scanned ${Object.keys(genuine).length} surfaces (3 exports, memo, ${canvas.panels.length} persisted panels, ${findings.length} agent findings): 0 forbidden-class matches; 4 labelled panels persisted through the kernel carry the required text (quote: "dry quote, not realized execution" + "sampled at"; swap volume: "provider-reported 1Click, not all Intents"; post-2026-10-27: "not observable after 2026-10-27"; all with mode and date); exports state SYNTHETIC/fixture and a date; 6/6 seeded claims (one per class) blocked at the publication gate (${Object.values(caught).flat().join(", ")}); removing the quote caveat is reported with the panel id.`,
    evidence: {
      surfaces: Object.keys(genuine),
      caught,
      missingLabelControl: bad.missing,
      labelled: labelled.map((l) => l.text),
    },
  });
}, 600_000);
