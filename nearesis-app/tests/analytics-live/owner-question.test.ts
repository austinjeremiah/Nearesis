/**
 * The owner's question, "Daily NEAR transactions vs Intents swap volume since May, with NEAR price", as the four panels the
 * composer proposed for it (panel queries: NEAR tx, swap count, NEAR price, swap volume). Before the rollup fix two of the four
 * (the swap panels) were rejected at validation with COST_CAP "Estimated 1767942855 rows exceeds the cap of 5000000".
 * Each panel's query is validated and executed through the SAME guarded gateway the composer's canvas.preview uses (cost gate,
 * coverage, envelope) and through the public web panel route. All four must pass; none may be estimated above the cap.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closePg,
  devLogin,
  liveAst,
  liveGateway,
  OWNER_SUBJECT,
  panel,
  registerAst,
  session,
  WORKSPACE,
  type LiveGw,
} from "./lib.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const FROM = "2026-05-01T00:00:00Z";
const TO = "2026-11-13T00:00:00Z";
const PANELS = [
  { title: "Daily NEAR transactions", measure: "live.near_tx_count", time: "near_daily_tx_live.day" },
  { title: "Intents swaps per day", measure: "live.oneclick_swap_count", time: "intents_swaps_live.day" },
  { title: "NEAR price", measure: "live.price_close_usd", time: "price_candles_live.day" },
  {
    title: "Intents swap volume (USD, known values)",
    measure: "live.oneclick_volume_usd_known",
    time: "intents_swaps_live.day",
  },
];
let token = "";
let tenant = "";
let g: LiveGw;
beforeAll(async () => {
  token = await devLogin(OWNER_SUBJECT);
  const w = await fetch(
    `${process.env.NEARESIS_API_URL ?? "http://127.0.0.1:4110"}/v1/workspaces/${WORKSPACE}`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  tenant = ((await w.json()) as { orgId: string }).orgId;
  g = liveGateway();
});
afterAll(async () => {
  await g.close();
  await closePg();
});

describe("owner question: all four panels validate and return real data", () => {
  for (const p of PANELS) {
    it(`${p.title}: passes the cost gate (estimate far below the 5M cap) and returns rows`, async () => {
      const ast = liveAst(
        { measures: [p.measure], limit: 3_000 + Math.floor(Math.random() * 6_000) },
        FROM,
        TO,
      );
      ast.time.field = p.time;
      const r = await g.gateway.query(session(tenant, WORKSPACE), ast);
      expect(r.ok, JSON.stringify(r.ok ? "" : r.error)).toBe(true);
      if (!r.ok) return;
      expect(r.envelope.cost.bytesEstimated / 200).toBeLessThan(5_000_000);
      expect(r.envelope.rows.length).toBe(196);
      // real values on most days
      expect(r.envelope.rows.filter((x) => x[1] !== null).length).toBeGreaterThan(150);
      // the public route serves the same panel
      const h = await registerAst({ ...ast, limit: 10_000 });
      const pub = await panel(token, h);
      expect(pub.status).toBe(200);
      expect(pub.body.chart.rows.length).toBe(196);
    });
  }
});
