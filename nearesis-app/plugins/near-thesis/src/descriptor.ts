import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ROOT } from "./manifest.ts";

/**
 * near-thesis registration descriptor (ch.25 "Bounty plugin manifest and registration" and "Typed capability dependency
 * graph"; ch.16b B11). Five registration point types; each registration declares its required grant, API version,
 * schema SHA, source-document link and test fixture. Activation checks the capability graph against the engine and
 * yields a disabled plugin with a readable dependency list instead of crashing.
 */
export const POINT_TYPES = [
  "dataPacks",
  "semanticViews",
  "researchTemplates",
  "agentTasks",
  "publisherTemplates",
] as const;
export type PointType = (typeof POINT_TYPES)[number];

export interface Registration {
  id: string;
  requiredGrant: string;
  apiVersion: number;
  /** sha256 of the canonical JSON of `schema`; activation recomputes and compares */
  schemaSha: string | null;
  schema: Record<string, unknown>;
  /** Build Bible chapter that specifies it */
  sourceDocument: string;
  /** repo-relative path (from nearesis-app) of a test fixture that exercises it */
  fixture: string;
}
export interface Descriptor {
  pluginId: string;
  version: string;
  registrations: Record<PointType, Registration[]>;
  requires: string[];
  uses: string[];
}

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
export const schemaSha = (schema: unknown): string =>
  createHash("sha256").update(canon(schema)).digest("hex");

const reg = (
  id: string,
  requiredGrant: string,
  schema: Record<string, unknown>,
  sourceDocument: string,
  fixture: string,
): Registration => ({
  id,
  requiredGrant,
  apiVersion: 1,
  schemaSha: schemaSha(schema),
  schema,
  sourceDocument,
  fixture,
});

const FX = "packages/test-fixtures";
const DATA_SCHEMA = (source: string) => ({
  type: "object",
  required: ["source", "watermark", "coverage"],
  properties: { source: { const: source } },
});
const VIEW_SCHEMA = (view: string) => ({
  type: "object",
  required: ["metrics", "dimensions"],
  properties: { view: { const: view } },
});

export const NEAR_THESIS_DESCRIPTOR: Descriptor = {
  pluginId: "near-thesis",
  version: "1.1.0",
  registrations: {
    dataPacks: [
      reg("bigquery.near", "data:bigquery:read", DATA_SCHEMA("bigquery.near"), "ch.14", `${FX}/fixtures`),
      reg(
        "explorer.oneclick",
        "data:explorer:read",
        DATA_SCHEMA("explorer.oneclick"),
        "ch.14",
        `${FX}/fixtures`,
      ),
      reg("quotes.oneclick", "data:quotes:dry", DATA_SCHEMA("quotes.oneclick"), "ch.14", `${FX}/fixtures`),
      reg("coingecko.near", "data:price:read", DATA_SCHEMA("coingecko.near"), "ch.14", `${FX}/fixtures`),
      reg(
        "partner.registry",
        "data:partners:read",
        DATA_SCHEMA("partner.registry"),
        "ch.14",
        `${FX}/fixtures`,
      ),
    ],
    semanticViews: ["near_usage", "intents", "quotes", "economics", "taxonomy"].map((v) =>
      reg(v, "semantic:read", VIEW_SCHEMA(v), "ch.08", "services/analytics/registry/metrics.v1.json"),
    ),
    researchTemplates: ["predictive_adoption", "value_capture", "quote_execution_quality"].map((t) =>
      reg(
        t,
        "research:run",
        {
          type: "object",
          required: ["hypothesis", "preregistration"],
          properties: { template: { const: t } },
        },
        "ch.08",
        `${FX}/research`,
      ),
    ),
    agentTasks: ["scout", "statistics", "skeptic", "proof_auditor"].map((a) =>
      reg(
        a,
        "agent:spawn",
        { type: "object", required: ["objective", "snapshotId"], properties: { task: { const: a } } },
        "ch.05",
        "packages/agent-runtime/roles",
      ),
    ),
    publisherTemplates: ["THESIS.md", "static_dashboard", "one_page_memo"].map((p) =>
      reg(
        p,
        "publish:static",
        { type: "object", required: ["claims", "results"], properties: { template: { const: p } } },
        "ch.19",
        "packages/capsule/fixtures",
      ),
    ),
  },
  requires: [
    "kernel.workspace@1",
    "kernel.agent_supervisor@1",
    "semantic.catalog@1",
    "research.experiment_registry@1",
    "canvas.panel_compiler@1",
    "evidence.provenance@1",
  ],
  uses: [
    "data.near.bigquery@1",
    "data.near.oneclick_explorer@1",
    "data.near.oneclick_quotes@1",
    "data.price.daily@1",
    "data.near.contract_registry@1",
    "model.near.predictive_thesis@1",
    "verify.outlayer@1",
    "publish.static@1",
    "publish.memo@1",
  ],
};

/** The engine interface -> the module in this repository that provides it. An interface is "provided" only if its module exists. */
export const ENGINE_PROVIDERS: Record<string, string> = {
  "kernel.workspace@1": "packages/kernel/src/workspace.ts",
  "kernel.agent_supervisor@1": "packages/agent-runtime/src/supervisor.ts",
  "semantic.catalog@1": "packages/semantic-gateway/src/gateway.ts",
  "research.experiment_registry@1": "services/research/nearesis_research/manifest.py",
  "canvas.panel_compiler@1": "packages/canvas-schema/src/compiler.ts",
  "evidence.provenance@1": "packages/kernel/src/graph.ts",
};
export function engineInterfaces(appRoot: string = join(PLUGIN_ROOT, "..", "..")): Set<string> {
  return new Set(
    Object.entries(ENGINE_PROVIDERS)
      .filter(([, p]) => existsSync(join(appRoot, p)))
      .map(([k]) => k),
  );
}

export interface ActivationReport {
  pluginId: string;
  state: "enabled" | "disabled";
  unmet: string[];
  reason: string | null;
  accepted: Array<{ type: PointType; id: string }>;
  rejected: Array<{ type: PointType; id: string; reason: string }>;
}
const FIELDS = ["requiredGrant", "apiVersion", "schemaSha", "sourceDocument", "fixture"] as const;

/** Validates every registration and the capability graph. Never throws: a broken plugin is reported disabled with reasons. */
export function activateDescriptor(
  d: Descriptor,
  engine: Set<string>,
  appRoot: string = join(PLUGIN_ROOT, "..", ".."),
): ActivationReport {
  const accepted: ActivationReport["accepted"] = [];
  const rejected: ActivationReport["rejected"] = [];
  for (const type of POINT_TYPES)
    for (const r of d.registrations[type] ?? []) {
      const missing = FIELDS.filter((f) => r[f] === null || r[f] === undefined || r[f] === "");
      if (missing.length) rejected.push({ type, id: r.id, reason: `missing ${missing.join(", ")}` });
      else if (r.schemaSha !== schemaSha(r.schema))
        rejected.push({ type, id: r.id, reason: "schemaSha does not match schema" });
      else if (!existsSync(join(appRoot, r.fixture)))
        rejected.push({ type, id: r.id, reason: `fixture ${r.fixture} not found` });
      else accepted.push({ type, id: r.id });
    }
  const unmet = d.requires.filter((r) => !engine.has(r));
  const state = unmet.length ? "disabled" : "enabled";
  return {
    pluginId: d.pluginId,
    state,
    unmet,
    reason: unmet.length ? `missing required engine interface(s): ${unmet.join(", ")}` : null,
    accepted,
    rejected,
  };
}
