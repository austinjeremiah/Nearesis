/**
 * C02 — Arbitrary JSX returned. PASS: schema validator rejects, no code execution.
 * Exercises the real validators (validatePanelSpec, validateCanvasPatchSemantics, applyCanvasPatch) that both the
 * kernel (server) and the web client use. Nothing is mocked.
 */
import { describe, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { applyCanvasPatch, validateCanvasPatchSemantics, validatePanelSpec } from "../../src/index.ts";
import { emptyDoc, NOW, panel, uuid } from "../fixtures/build.ts";
import { loadFixture } from "../fixtures/manifest.ts";

interface Case {
  name: string;
  value?: string;
  merge?: Record<string, unknown>;
  mergeEncoding?: Record<string, unknown>;
  rawJson?: string;
  expect: string;
}

describe("C02 arbitrary JSX is rejected without execution", () => {
  it("rejects every executable-content case at panel and patch level", () => {
    const fx = loadFixture<{ panelCases: Case[] }>("fx.canvas.jsx-corpus", "corpus.json");
    const g = globalThis as Record<string, unknown>;
    delete g.__c02_tripwire;
    const rows: Array<{ case: string; panelCodes: string[]; patchRejected: boolean; revisionAfter: number }> =
      [];

    const build = (c: Case): unknown => {
      if (c.value !== undefined) return c.value;
      if (c.rawJson !== undefined) return JSON.parse(c.rawJson); // JSON.parse creates an own "__proto__" key
      const p = panel(1) as unknown as Record<string, unknown>;
      return {
        ...p,
        ...(c.merge ?? {}),
        ...(c.mergeEncoding ? { encoding: { ...(p.encoding as object), ...c.mergeEncoding } } : {}),
      };
    };

    const cases: Array<{ name: string; value: unknown; expect: string }> = fx.data.panelCases.map((c) => ({
      name: c.name,
      value: build(c),
      expect: c.expect,
    }));
    // In-process cases: a real function and an accessor that would trip the wire if anything executed them.
    const trip = () => {
      g.__c02_tripwire = true;
      return "x";
    };
    cases.push({ name: "function-value", value: { ...panel(1), title: trip }, expect: "EXECUTABLE_CONTENT" });
    const withGetter: Record<string, unknown> = { ...panel(1) };
    Object.defineProperty(withGetter, "title", { enumerable: true, get: trip });
    cases.push({ name: "getter-property", value: withGetter, expect: "EXECUTABLE_CONTENT" });

    for (const c of cases) {
      const r = validatePanelSpec(c.value);
      expect(r.ok, c.name).toBe(false);
      const codes = r.ok ? [] : r.issues.map((i) => i.code);
      expect(codes, c.name).toContain(c.expect);

      const doc = emptyDoc();
      const patch = {
        schemaVersion: 1,
        type: "workspace.patch",
        operationId: uuid(42),
        expectedRevision: 0,
        operations: [
          { op: "addPanel", panel: panel(2) },
          { op: "addPanel", panel: c.value },
        ],
      };
      const report = validateCanvasPatchSemantics(doc, patch);
      const applied = applyCanvasPatch(doc, patch, { now: NOW });
      expect(report.ok, c.name).toBe(false);
      expect(applied.ok, c.name).toBe(false);
      rows.push({
        case: c.name,
        panelCodes: [...new Set(codes)],
        patchRejected: !applied.ok,
        revisionAfter: doc.documentRevision,
      });
    }

    // No code execution: tripwire untouched, no prototype pollution.
    expect(g.__c02_tripwire).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(rows.every((r) => r.revisionAfter === 0)).toBe(true);

    observe({
      testId: "C02",
      observed: `${rows.length}/${rows.length} executable-content specs rejected at panel and patch level (incl. JSX strings, render/component/jsx/formatter/handler props, unregistered kind, __proto__, function value, getter); tripwire never set; no prototype pollution; document revision unchanged (0)`,
      fixtureHash: fx.fixtureHash,
      evidence: { fixture: "fx.canvas.jsx-corpus", label: fx.label, cases: rows, tripwireSet: false },
    });
  });
});
