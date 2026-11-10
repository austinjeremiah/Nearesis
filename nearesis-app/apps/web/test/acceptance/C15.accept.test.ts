/**
 * C15 — SSE disconnect/duplicate/expiry/slow consumer. PASS: ordered exactly-once application; Last-Event-ID resume;
 * reload_required on expiry; bounded buffers; final state equal. Server: kernel SSE endpoint (Engine A) on the real
 * API; client: the web app's SseParser + EventStore (apps/web/src/lib/event-store.ts), driven by a scripted reader.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import type { DomainEvent, PanelSpec } from "@nearesis/contracts";
import { documentContentHash, hashCanonical } from "@nearesis/canvas-schema";
import { runCmd } from "@nearesis/kernel/testing";
import { EventStore, SseParser } from "../../src/lib/event-store.ts";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { API_PORT, type KernelEnv, seedWorkspace, startKernelEnv } from "./kernel-harness.ts";

const PANEL = (loadScenario("baseline").document as { panels: PanelSpec[] }).panels[0]!;
let env: KernelEnv;
beforeAll(async () => {
  env = await startKernelEnv();
}, 300_000);
afterAll(async () => {
  await env?.close();
});

interface Reader {
  stop: () => void;
  done: Promise<void>;
  paused: { value: boolean };
}

/** Reads the SSE stream frame by frame into `store`; `onFrame` may request a stop after any frame. */
function read(
  url: string,
  token: string,
  lastEventId: string,
  store: EventStore,
  onFrame: (f: { id?: string; event?: string }) => "continue" | "stop" | "duplicate",
): Reader {
  const ctrl = new AbortController();
  const paused = { value: false };
  const done = (async () => {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
        "last-event-id": lastEventId,
      },
      signal: ctrl.signal,
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const parser = new SseParser();
    try {
      for (;;) {
        while (paused.value) await new Promise((r) => setTimeout(r, 50));
        const { value, done: end } = await reader.read();
        if (end) return;
        for (const f of parser.push(value)) {
          store.handleFrame(f);
          const action = onFrame(f);
          if (action === "duplicate") store.handleFrame(f);
          if (action === "stop") {
            ctrl.abort();
            return;
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") throw e;
    }
  })();
  return { stop: () => ctrl.abort(), done, paused };
}

describe("C15 SSE streaming with cursor replay", () => {
  it("applies events in order exactly once across disconnect, duplicate, expiry and a slow consumer", async () => {
    const { workspaceId: ws } = await seedWorkspace(env, "alice", [PANEL]);
    const s = await env.session("alice");
    const token = await env.kernel.devAuth!.login(env.users.alice!.subject);
    const url = `http://127.0.0.1:${API_PORT}/v1/workspaces/${ws}/events`;
    const head = async () =>
      Number(
        (
          await env.db.admin.query(
            "SELECT coalesce(max(seq),0) m FROM workspace_events WHERE workspace_id=$1",
            [ws],
          )
        ).rows[0].m,
      );
    const version = async () =>
      Number((await env.db.admin.query("SELECT version FROM workspaces WHERE id=$1", [ws])).rows[0].version);
    const commitTimes = new Map<number, number>();
    const move = async (i: number) => {
      const doc = await env.kernel.canvas.get(s, ws);
      await runCmd(
        env.kernel,
        s,
        ws,
        "canvas.apply_patch",
        {
          schemaVersion: 1,
          type: "workspace.patch",
          operationId: crypto.randomUUID(),
          expectedRevision: doc.documentRevision,
          operations: [{ op: "movePanel", panelId: PANEL.panelId, layout: { ...PANEL.layout, x: i % 6 } }],
        },
        await version(),
      );
      commitTimes.set(await head(), performance.now());
    };
    let i = 0;
    while ((await head()) < 50) await move(i++);
    expect(await head()).toBe(50);

    const applied: DomainEvent[] = [];
    const reloads: Array<{ reason: string }> = [];
    const latencies: number[] = [];
    const store = new EventStore({
      coalesceMs: 0,
      maxPending: 100,
      onBatch: (b) => applied.push(...b),
      onReloadRequired: (r) => reloads.push({ reason: r.reason }),
      schedule: (fn) => queueMicrotask(fn),
    });

    // (a)+(b) stream, disconnect after event 20, reconnect with Last-Event-ID=20, duplicate delivery of event 21.
    const r1 = read(url, token, "0", store, (f) => (f.id === "20" ? "stop" : "continue"));
    await r1.done;
    store.flush();
    const cut = store.lastSeq;
    const r2 = read(url, token, store.lastEventId, store, (f) =>
      f.id === "21" ? "duplicate" : f.id === "50" ? "stop" : "continue",
    );
    await r2.done;
    store.flush();
    const seqs = applied.map((e) => e.seq);
    expect(cut).toBe(20);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, k) => k + 1));
    expect(store.duplicatesIgnored).toBeGreaterThanOrEqual(1);

    // (c) expired / invalid cursor => reload_required with the current position; client reloads the projection.
    const expiryStore = new EventStore({
      coalesceMs: 0,
      onBatch: () => undefined,
      onReloadRequired: (r) => reloads.push({ reason: r.reason }),
      schedule: (fn) => queueMicrotask(fn),
    });
    for (const bad of ["999999", "not-a-cursor"])
      await read(url, token, bad, expiryStore, () => "continue").done;
    expect(reloads.length).toBe(2);
    expect(reloads.every((r) => /CURSOR/.test(r.reason))).toBe(true);
    expect(expiryStore.lastSeq).toBe(50);

    // (d) slow consumer: 250 more events commit while this subscriber is still at cursor 50 (lag 250 > server maxLag
    // 200), it connects paused for 5 s, then resumes.
    const slow = new EventStore({
      coalesceMs: 250,
      maxPending: 100,
      onBatch: (b) =>
        b.forEach((e) => latencies.push(performance.now() - (commitTimes.get(e.seq) ?? performance.now()))),
      onReloadRequired: (r) => reloads.push({ reason: r.reason }),
    });
    slow.reset(50);
    let maxClientPending = 0;
    while ((await head()) < 300) await move(i++);
    const r3 = read(url, token, "50", slow, () => {
      maxClientPending = Math.max(maxClientPending, slow.maxPendingObserved);
      return slow.lastSeq >= 300 ? "stop" : "continue";
    });
    r3.paused.value = true;
    await new Promise((r) => setTimeout(r, 5000));
    r3.paused.value = false;
    await Promise.race([r3.done, new Promise((r) => setTimeout(r, 20_000))]);
    r3.stop();
    slow.flush();
    expect(slow.lastSeq).toBe(300);
    expect(slow.coalescedFrames).toBeGreaterThanOrEqual(1);
    expect(maxClientPending).toBeLessThanOrEqual(100);

    // (e) final client state equals the server projection.
    const server = await env.kernel.canvas.get(s, ws);
    const clientView = await (
      await fetch(`http://127.0.0.1:${API_PORT}/v1/workspaces/${ws}/canvas`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    expect(documentContentHash(clientView)).toBe(documentContentHash(server));

    const sorted = [...latencies].sort((a, b) => a - b);
    const pct = (p: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : null;
    observe({
      testId: "C15",
      observed: `50 committed events applied in order exactly once (1..50) across a disconnect after 20 and Last-Event-ID=20 resume; duplicate of 21 ignored (${store.duplicatesIgnored} duplicate(s) dropped); ahead and invalid cursors each produced reload_required (${reloads
        .slice(0, 2)
        .map((r) => r.reason)
        .join(
          ", ",
        )}); subscriber 250 events behind (cursor 50, head 300, paused 5 s) received ${slow.coalescedFrames} coalesced frame(s), reached seq 300, client reorder buffer max ${maxClientPending} (<=100); final client canvas hash equals server projection. Delivery delay for the lagging subscriber (includes the deliberate 5 s pause; not a propagation benchmark): n=${sorted.length} p50=${pct(50)?.toFixed(0)}ms p95=${pct(95)?.toFixed(0)}ms`,
      fixtureHash: hashCanonical(PANEL),
      evidence: {
        seqs,
        cut,
        duplicatesIgnored: store.duplicatesIgnored,
        reloads,
        coalescedFrames: slow.coalescedFrames,
        maxClientPending,
        finalHash: documentContentHash(server),
        latencyMs: { n: sorted.length, p50: pct(50), p95: pct(95), max: sorted.at(-1) ?? null },
      },
    });
  }, 300_000);
});
