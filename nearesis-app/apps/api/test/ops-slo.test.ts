import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SLOS } from "@nearesis/workflow";
import { startOpsBackground } from "../src/ops-background.ts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

/**
 * Direct tests for `GET /v1/ops/slo` and `startOpsBackground` (ch.13 observability): the route reports the multi-window
 * burn state of every declared SLO from recorded buckets, and the background loop flushes the recorder and sends a
 * burn alert through the kernel event path (audit) for a sustained outage, once per alert key.
 */
let f: ApiFixture;
let tok: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  f = await apiFixture({ runtime: true });
  const o = await seedOrg(f.db.admin, "slo", { sam: "owner" });
  tok = await login(f.app, o.users.sam!.subject);
}, 120_000);
afterAll(async () => f?.close());

const slo = () =>
  f.app.inject({ url: "/v1/ops/slo", headers: bearer(tok) }).then((r) => ({
    status: r.statusCode,
    body: r.json() as { slos: Array<{ id?: string; slo?: { id: string }; firing: unknown[] }> },
  }));

describe("GET /v1/ops/slo", () => {
  it("requires authentication", async () => {
    const r = await f.app.inject({ url: "/v1/ops/slo" });
    expect(r.statusCode).toBe(401);
  });

  it("lists every declared SLO with no firing rule when nothing has been recorded", async () => {
    const r = await slo();
    expect(r.status).toBe(200);
    expect(r.body.slos).toHaveLength(SLOS.length);
    for (const s of r.body.slos) expect(s.firing).toHaveLength(0);
  });
});

describe("startOpsBackground", () => {
  it("flushes recorded events, reports the burn on the route, and alerts once for a sustained outage", async () => {
    const ops = startOpsBackground(f.kernel, { intervalMs: 100 });
    try {
      const now = Date.now();
      // healthy history, then six minutes of 90% errors: both burn windows exceed the page factor
      for (let m = 60; m > 6; m--)
        ops.recorder.record("api_availability", 1000, 1000, new Date(now - m * 60_000));
      for (let m = 6; m >= 0; m--)
        ops.recorder.record("api_availability", 100, 1000, new Date(now - m * 60_000));
      const audit = async () =>
        f.db.admin
          .query("SELECT subject, detail FROM audit_events WHERE action = 'alert.slo.burn'")
          .then((r) => r.rows as Array<{ subject: string; detail: Record<string, unknown> }>);
      let rows: Awaited<ReturnType<typeof audit>> = [];
      for (let i = 0; i < 100 && rows.length === 0; i++) {
        await sleep(100);
        rows = await audit();
      }
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]!.subject).toContain("api_availability");
      const sent = rows.length;
      await sleep(600); // several more evaluations: the same alert keys are duplicates inside the window
      expect((await audit()).length).toBe(sent);
      const r = await slo();
      const a = r.body.slos.find((s) => (s.id ?? s.slo?.id) === "api_availability")!;
      expect(a.firing.length).toBeGreaterThanOrEqual(1);
    } finally {
      await ops.stop();
    }
  }, 60_000);

  it("stop() flushes what is buffered and ends the loop", async () => {
    const ops = startOpsBackground(f.kernel, { intervalMs: 3_600_000 });
    ops.recorder.record("api_availability", 1, 1);
    await ops.stop();
    const q = await f.db.admin.query(
      "SELECT 1 FROM runtime.slo_buckets WHERE slo_id = 'api_availability' AND good >= 1",
    );
    expect(q.rowCount).toBeGreaterThan(0);
  });
});
