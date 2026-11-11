/**
 * SEC21: data classification end to end. PASS: 0 private-labelled content in telemetry, broad fan-out events or requests
 * to an unapproved model; private content reaches only the approved model binding and workspace-scoped storage; the public
 * MCP tools return only published, snapshot-backed capsule content (no drafts, no permissions); panel exports show no
 * private raw field.
 * Real kernel and Postgres (disposable), real outbox, a real OTLP/HTTP exporter and real HTTP capture servers for the
 * approved and unapproved model endpoints and the telemetry receiver, real public MCP server.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import type { InferenceProvider } from "../../packages/contracts/src/index.ts";
import {
  OutboxPublisher,
  TelemetryExporter,
  ClassificationPolicy,
  guardInference,
  maxLabel,
  panelExportView,
  publicValue,
  withDataLabel,
} from "../../packages/kernel/src/index.ts";
import type { DataLabel } from "../../packages/kernel/src/index.ts";
import { addNode, addPanel, newWs, snapshot, world } from "../../packages/kernel/test/history/helpers.ts";
import type { World } from "../../packages/kernel/test/history/helpers.ts";
import { PUBLIC_TOOLS } from "../../services/mcp-public/src/index.ts";
import { connect, jsonOf, makeRoot } from "../../services/mcp-public/test/helpers.ts";

let w: World;
const servers: Server[] = [];
beforeAll(async () => {
  w = await world("sec21");
}, 120_000);
afterAll(async () => {
  servers.forEach((s) => s.close());
  await w?.db.drop();
});

interface Capture {
  url: string;
  bodies: string[];
}
async function capture(): Promise<Capture> {
  const bodies: string[] = [];
  const srv = createServer((rq, rs) => {
    const chunks: Buffer[] = [];
    rq.on("data", (c: Buffer) => chunks.push(c));
    rq.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      rs.setHeader("content-type", "application/json");
      rs.end("{}");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/`, bodies };
}

/** A real HTTP model binding: posts the prompt to its endpoint. */
function httpProvider(id: string, url: string): InferenceProvider {
  const stub = () => {
    throw new Error("unused");
  };
  return {
    id,
    health: async () => ({ ok: true, detail: "capture" }),
    listModels: async () => [],
    verifyResponse: async () => ({ verified: false, status: "unsupported", checks: [] }),
    streamText: stub as never,
    generateStructured: async <T>(a: { system: string; prompt: string; schema: z.ZodType<T> }) => {
      await fetch(url, { method: "POST", body: JSON.stringify({ system: a.system, prompt: a.prompt }) });
      return {
        output: a.schema.parse({ ok: true }),
        provider: id,
        model: "capture",
        requestId: null,
        usage: { inputTokens: 1, outputTokens: 1 },
        evidence: null,
        rawResponseSha256: "0".repeat(64),
      };
    },
  };
}

const tag = randomBytes(4).toString("hex");
const CANARY = {
  draft: `CANARY-DRAFT-${tag}`,
  note: `CANARY-NOTE-${tag}`,
  evidence: `CANARY-EVID-${tag}`,
  internal: `CANARY-INTERNAL-${tag}`,
  public: `PUBLIC-CLAIM-${tag}`,
};
const PRIVATE_CANARIES = [CANARY.draft, CANARY.note, CANARY.evidence, CANARY.internal];
const leaks = (texts: string[]) => PRIVATE_CANARIES.filter((c) => texts.some((t) => t.includes(c)));

it("SEC21: private and internal content never reaches public telemetry, fan-out, an unapproved model or the public API", async () => {
  const otlp = await capture();
  const approved = await capture();
  const unapproved = await capture();
  const ws = (await newWs(w)).workspaceId;
  const panel = await addPanel(w, ws, 0);
  const items: Array<{ id: string; label: DataLabel; text: string; data: Record<string, unknown> }> = [];
  const mk = async (kind: string, text: string, label: DataLabel, data: Record<string, unknown> = {}) => {
    const id = await addNode(w, ws, kind, text, { data });
    await w.k.classification.set(w.owner, ws, "evidence_node", id, label);
    items.push({ id, label, text, data });
  };
  await mk("hypothesis", CANARY.draft, "private", { draft: true, body: CANARY.draft });
  await mk("observation", CANARY.note, "private", { note: CANARY.note });
  await mk("source", "private evidence", "private", { excerpt: CANARY.evidence });
  await mk("observation", CANARY.internal, "internal");
  await mk("claim", CANARY.public, "public");
  const unlabelledId = await addNode(w, ws, "observation", `unlabelled ${CANARY.note}`);
  const labels = await w.k.classification.labelsOf(w.owner, ws, "evidence_node");
  expect(labels.get(unlabelledId)).toBeUndefined(); // no row: treated as private
  const labelOf = (id: string): DataLabel => labels.get(id) ?? "private";
  expect(labelOf(unlabelledId)).toBe("private");
  await snapshot(w, ws, "golden");

  // ---- telemetry and broad fan-out: a careless consumer passes labels and bodies straight to the exporter
  const exporter = new TelemetryExporter(otlp.url);
  const pub = new OutboxPublisher(w.db.app);
  const fanout: string[] = [];
  const inWorkspace: string[] = [];
  pub.register(
    "telemetry",
    async ({ event }) => {
      fanout.push(JSON.stringify(event));
      const node = (event.data as { node?: { label?: string; data?: unknown } }).node;
      exporter.span("workspace.event", {
        type: publicValue(event.type),
        seq: event.seq,
        change: publicValue(String((event.data as { change?: string }).change ?? "")),
        label: node?.label ?? "", // careless: raw workspace text as an attribute
        prompt: publicValue(JSON.stringify(node?.data ?? {})), // careless: even marked public, a content attribute
      });
    },
    { broad: true },
  );
  pub.register("workspace-projection", async ({ event }) => {
    inWorkspace.push(JSON.stringify(event));
  });
  const run = await pub.runOnce(100);
  const exported = await exporter.flush();
  expect(run.failed).toBe(0);
  expect(exported).toBeGreaterThan(5);
  expect(inWorkspace.join("")).toContain(CANARY.draft); // control: the in-workspace consumer does get the full event
  expect(leaks(fanout)).toEqual([]);
  expect(leaks(otlp.bodies)).toEqual([]);
  expect(exporter.withheld.length).toBeGreaterThan(0);
  expect(otlp.bodies.join("")).toContain("[withheld:");

  // ---- model egress: approved and unapproved bindings, every label, plus an undeclared (default private) call
  const policy = new ClassificationPolicy({ approvedModelBindings: ["near-ai-capture"] });
  const good = guardInference(httpProvider("near-ai-capture", approved.url), policy);
  const bad = guardInference(httpProvider("openrouter-capture", unapproved.url), policy);
  const schema = z.object({ ok: z.boolean() });
  const call = (p: InferenceProvider, text: string, label: DataLabel | null, key: string) => {
    const run = () =>
      p.generateStructured({
        model: "m",
        system: "s",
        prompt: text,
        schema,
        idempotencyKey: key,
        maxTokens: 10,
      });
    return (label ? withDataLabel(label, run) : run()).then(
      () => "sent",
      (e) => (e as { reasonCode?: string }).reasonCode ?? "error",
    );
  };
  const outcomes: Array<{ label: string; binding: string; outcome: string }> = [];
  for (const it of items) {
    const l = labelOf(it.id);
    for (const [name, p] of [
      ["approved", good],
      ["unapproved", bad],
    ] as const)
      outcomes.push({
        label: l,
        binding: name,
        outcome: await call(p, `summarise: ${it.text} ${JSON.stringify(it.data)}`, l, `k-${it.id}-${name}`),
      });
  }
  const undeclared = await call(bad, `summarise: ${CANARY.note}`, null, "k-undeclared");
  const undeclaredApproved = await call(good, `summarise: ${CANARY.note}`, null, "k-undeclared-ok");
  const mixed = maxLabel(...items.map((i) => i.label));
  expect(mixed).toBe("private");
  for (const o of outcomes) {
    if (o.binding === "approved") expect(o.outcome).toBe("sent");
    else expect(o.outcome).toBe(o.label === "public" ? "sent" : "CLASSIFICATION_DENIED");
  }
  expect(undeclared).toBe("CLASSIFICATION_DENIED");
  expect(undeclaredApproved).toBe("sent");
  expect(leaks(unapproved.bodies)).toEqual([]);
  expect(unapproved.bodies.some((b) => b.includes(CANARY.public))).toBe(true); // public content may go there
  expect(PRIVATE_CANARIES.every((c) => approved.bodies.some((b) => b.includes(c)))).toBe(true);
  expect(unapproved.bodies).toHaveLength(1); // denied calls built no request at all

  // ---- workspace-scoped storage: the other tenant cannot read labels or private nodes
  const bobLabels = await w.k.classification.labelsOf(w.outsider, ws, "evidence_node");
  const bobRows = await w.k.db.tx(
    { orgId: w.orgB.orgId, userId: w.outsider.userId, actorKind: "human" },
    (tx) => tx.query("SELECT count(*)::int n FROM evidence_nodes WHERE workspace_id = $1", [ws]),
  );
  expect(bobLabels.size).toBe(0);
  expect(bobRows.rows[0].n).toBe(0);

  // ---- public API: the public MCP tools over published capsules; drafts and workspace data are absent
  const { root, capsuleId } = makeRoot();
  const draft = join(root, `draft-${tag}`);
  mkdirSync(draft, { recursive: true });
  writeFileSync(join(draft, "notes.md"), `${CANARY.draft} unpublished`);
  const broken = join(root, `unsigned-${tag}`);
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "manifest.json"), JSON.stringify({ title: CANARY.internal }));
  const c = await connect(root, { id: "anonymous", kind: "anonymous" });
  const publicOut: string[] = [];
  const ids = [capsuleId, `draft-${tag}`, `unsigned-${tag}`, "workspace"];
  for (const name of PUBLIC_TOOLS) {
    for (const id of ids) {
      const args =
        name === "list_capsules"
          ? {}
          : name === "get_export"
            ? { capsuleId: id, name: "THESIS.md" }
            : name === "get_result"
              ? { capsuleId: id, resultId: "r1" }
              : { capsuleId: id };
      const r = await c.client.callTool({ name, arguments: args });
      publicOut.push(JSON.stringify(r));
    }
  }
  const listed = jsonOf(await c.client.callTool({ name: "list_capsules", arguments: {} })) as {
    capsules: Array<{ capsuleId: string }>;
  };
  await c.close();
  expect(listed.capsules.map((x) => x.capsuleId)).toEqual([capsuleId]);
  expect(leaks(publicOut)).toEqual([]);
  expect(publicOut.join("")).not.toContain(`draft-${tag}`);
  const members = [w.orgA.users.alice!.subject, w.orgA.users.ann!.subject, w.orgA.users.vic!.subject];
  expect(members.filter((m) => publicOut.join("").includes(m))).toEqual([]);

  // ---- panel exports and tooltips
  const spec = {
    panelId: panel.panel.panelId,
    title: "Wallet balances",
    dataBinding: {
      fields: ["day", "volume", "wallet_owner"],
      units: { volume: "USD", wallet_owner: "text" },
    },
    encoding: { x: "day", y: ["volume"], tooltip: ["day", "volume", "wallet_owner"] },
  };
  const fieldLabel = (f: string): DataLabel =>
    f === "wallet_owner" ? "private" : f === "day" ? "public" : f === "volume" ? "public" : "private";
  const pubView = panelExportView(spec, fieldLabel, "public");
  const memberView = panelExportView(spec, fieldLabel, "member");
  const unknownField = panelExportView(
    { ...spec, dataBinding: { fields: ["mystery"] }, encoding: { tooltip: ["mystery"] } },
    () => "private",
    "public",
  );
  expect(pubView.encoding.tooltip).toEqual(["day", "volume"]);
  expect(pubView.dataBinding.fields).toEqual(["day", "volume"]);
  expect(JSON.stringify(pubView)).not.toContain("wallet_owner");
  expect(memberView.encoding.tooltip).toContain("wallet_owner");
  expect(unknownField.dataBinding.fields).toEqual([]);

  // ---- negative control: an exporter that sends prompts as-is FAILS criterion (a)
  const naiveSink = await capture();
  await fetch(naiveSink.url, {
    method: "POST",
    body: JSON.stringify({ spans: [{ attributes: [{ key: "prompt", value: CANARY.draft }] }] }),
  });
  expect(leaks(naiveSink.bodies)).toEqual([CANARY.draft]);

  observe({
    testId: "SEC21",
    observed: `workspace with 6 items (draft, user note and private evidence labelled private, 1 internal, 1 public, 1 unlabelled which reads as private); golden flow through the real outbox: ${run.delivered} deliveries, the broad fan-out consumer received ${fanout.length} minimal events with 0 private canaries (the in-workspace consumer got the full events, control), the OTLP exporter sent ${exported} spans with 0 private canaries (${exporter.withheld.length} careless attributes withheld, raw labels and prompt-named attributes included); model egress: ${outcomes.length} labelled calls x 2 bindings plus an undeclared call: the unapproved binding received exactly 1 request (the public item), every private or internal call to it and the undeclared call were refused CLASSIFICATION_DENIED before any request was built, the approved binding received all 4 private canaries; other tenant sees 0 labels and 0 private nodes; public MCP tools (${PUBLIC_TOOLS.length} tools x ${ids.length} ids incl. a draft directory and an unsigned manifest) returned only the published capsule, 0 private canaries, 0 member identifiers, list_capsules = [published capsule]; public panel export dropped the private tooltip and data field (and every unlabelled field), member view unchanged; control: an exporter posting the prompt as-is leaks the draft canary`,
    fixtureHash: createHash("sha256").update(`sec21-v1`).digest("hex"),
    evidence: {
      labels: Object.fromEntries(items.map((i) => [i.id, i.label])),
      outcomes,
      undeclared,
      fanoutEvents: fanout.length,
      otlpSpans: exported,
      withheldAttributes: exporter.withheld.length,
      captureInventory: {
        otlp: otlp.bodies.length,
        approved: approved.bodies.length,
        unapproved: unapproved.bodies.length,
      },
      publicTools: PUBLIC_TOOLS.length,
    },
  });
}, 600_000);
