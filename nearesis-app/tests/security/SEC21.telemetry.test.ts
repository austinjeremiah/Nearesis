/**
 * SEC21 production half: the kernel's own outbox feeds a real OTLP/HTTP export path (TelemetryPipeline) through the broad
 * consumer route, so only fanoutEvent output can reach the collector, and every exported span is a valid OTLP span.
 * Real kernel, real outbox and Postgres (disposable); the collector is a real HTTP server on loopback.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  TELEMETRY_CONSUMER,
  TelemetryExporter,
  TelemetryPipeline,
  otlpTracesEndpoint,
  publicValue,
} from "../../packages/kernel/src/index.ts";
import { addNode, newWs, world } from "../../packages/kernel/test/history/helpers.ts";
import type { World } from "../../packages/kernel/test/history/helpers.ts";

const CANARY = { label: "CANARY-PRIVATE-LABEL-7f3a", note: "CANARY-PRIVATE-NOTE-91bc" };
let w: World;
let collector: Server;
const received: Array<{ url: string; body: string }> = [];
let status = 200;
beforeAll(async () => {
  collector = createServer((rq, rs) => {
    const c: Buffer[] = [];
    rq.on("data", (x: Buffer) => c.push(x));
    rq.on("end", () => {
      received.push({ url: rq.url ?? "", body: Buffer.concat(c).toString("utf8") });
      rs.statusCode = status;
      rs.end("{}");
    });
  });
  await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
  const port = (collector.address() as { port: number }).port;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
  w = await world("sec21t"); // the kernel built here picks the endpoint up from the environment
}, 120_000);
afterAll(async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  collector?.close();
  await w?.db.drop();
});

it("a configured endpoint wires a broad telemetry consumer; exported spans are valid OTLP and carry no private content", async () => {
  expect(w.k.telemetry).not.toBeNull();
  const ws = (await newWs(w)).workspaceId;
  await addNode(w, ws, "observation", CANARY.label, { data: { note: CANARY.note } });
  await addNode(w, ws, "hypothesis", CANARY.note, { data: { draft: true, body: CANARY.note } });
  const run = await w.k.outbox.runOnce(100);
  expect(run.delivered).toBeGreaterThan(0);
  const sent = await w.k.telemetry!.flush();
  expect(sent).toBeGreaterThan(0);

  expect(received.length).toBeGreaterThan(0);
  expect(received.every((r) => r.url === "/v1/traces")).toBe(true);
  const all = received.map((r) => r.body).join("\n");
  expect(all).not.toContain(CANARY.label);
  expect(all).not.toContain(CANARY.note);
  const spans = received.flatMap(
    (r) =>
      (
        JSON.parse(r.body) as {
          resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
        }
      ).resourceSpans[0]!.scopeSpans[0]!.spans,
  );
  expect(spans.length).toBe(sent);
  for (const s of spans) {
    expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(s.name).toBe("nearesis.event");
    expect(String(s.startTimeUnixNano)).toMatch(/^\d{19}$/);
  }
  const types = spans.flatMap((s) =>
    (s.attributes as Array<{ key: string; value: { stringValue?: string } }>)
      .filter((a) => a.key === "event.type")
      .map((a) => a.value.stringValue),
  );
  expect(types.length).toBe(spans.length);
  expect(types.every((t) => /^[a-z_.]+$/i.test(t ?? ""))).toBe(true);
  // the consumer is registered as broad: an in-workspace consumer gets the full event, the telemetry consumer never does
  let full = "";
  w.k.outbox.register("probe", async ({ event }) => void (full += JSON.stringify(event)));
  await addNode(w, ws, "observation", CANARY.label);
  await w.k.outbox.runOnce(100);
  expect(full).toContain(CANARY.label);
  expect(TELEMETRY_CONSUMER).toBe("telemetry");
});

it("a down or failing collector never throws into the caller; spans are kept (bounded) and counted when dropped", async () => {
  status = 503;
  const log: Array<Record<string, unknown>> = [];
  const p = new TelemetryPipeline(
    new TelemetryExporter(
      `http://127.0.0.1:${(collector.address() as { port: number }).port}/v1/traces`,
      "t",
      undefined,
      3,
    ),
    (l) => log.push(l),
  );
  for (let i = 0; i < 5; i++) p.exporter.span("x", { n: i });
  expect(await p.flush()).toBe(0);
  expect(p.exporter.buffered).toBe(3);
  expect(p.exporter.dropped).toBe(2);
  expect(log[0]).toMatchObject({ msg: "telemetry.flush_failed" });
  status = 200;
  expect(await p.flush()).toBe(3);
  expect(p.exporter.buffered).toBe(0);
});

it("with no endpoint configured, or an unusable one, telemetry is off", () => {
  const env = (m: Record<string, string>) => (n: string) => m[n];
  expect(otlpTracesEndpoint(env({}))).toBeNull();
  expect(otlpTracesEndpoint(env({ OTEL_EXPORTER_OTLP_ENDPOINT: "file:///etc/passwd" }))).toBeNull();
  expect(otlpTracesEndpoint(env({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://u:p@h:4318" }))).toBeNull();
  expect(otlpTracesEndpoint(env({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://h:4318/" }))).toBe(
    "http://h:4318/v1/traces",
  );
  expect(TelemetryPipeline.fromEnv(env({}))).toBeNull();
  // a careless attribute is still withheld by the exporter
  const e = new TelemetryExporter("http://127.0.0.1:1/");
  e.span("x", { prompt: publicValue(CANARY.note), raw: CANARY.note });
  expect(e.withheld.sort()).toEqual(["prompt", "raw"]);
});
