import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/** Collects every route Fastify registers while `buildApp` runs (onRoute hook on the root instance, inherited by plugins). */
const live = vi.hoisted(() => ({ routes: [] as Array<{ method: string; url: string }> }));
vi.mock("fastify", async (orig) => {
  const m = await orig<typeof import("fastify")>();
  const make = ((...a: unknown[]) => {
    const app = (m.default as (...x: unknown[]) => import("fastify").FastifyInstance)(...a);
    app.addHook("onRoute", (r) => {
      for (const method of ([] as unknown[]).concat(r.method))
        live.routes.push({ method: String(method), url: r.url });
    });
    return app;
  }) as typeof m.default;
  return { ...m, default: make };
});

import {
  API_STATES,
  API_STATE_INFO,
  ApiState,
  ChartData,
  DataStateEnvelope,
  ErrorCode,
  ErrorResponse,
  REASON_CODE_STATE,
  SSE_EVENTS,
  SSE_SCHEMAS,
  CONTRACTS_VERSION,
  stateOfError,
} from "@nearesis/contracts";
import {
  CostPolicyBody,
  GlobalSpendStatus,
  LedgerExport,
  RunListResponse,
  SourceListResponse,
  SubmitQuestionResponse,
  CommandAccepted,
  CreateWorkspaceResponse,
  WorkspaceBurn,
  WorkspaceReconciliation,
} from "@nearesis/contracts";
import { KernelError, toErrorResponse } from "@nearesis/kernel";
import { buildApp } from "../src/app.ts";
import { DOCS_API_DIR, buildSpec, generatedFiles } from "../src/openapi-cli.ts";
import { ROUTES } from "../src/openapi-routes.ts";

const stubKernel = new Proxy({} as Record<string, unknown>, {
  get: (_t, k) => (k === "then" ? undefined : () => new Proxy({}, { get: () => () => ({}) })),
});
const toOas = (p: string) => p.replace(/:([A-Za-z_]+)/g, "{$1}").replace(/\/\*$/, "/{path}");

describe("OpenAPI: no drift between code, route table and committed docs", () => {
  it("every route registered by buildApp is in the route table and the reverse (HEAD excluded)", async () => {
    live.routes.length = 0;
    const app = await buildApp({
      kernel: stubKernel as never,
      gatewayCredential: { secret: "x".repeat(32), audience: "nearesis-api" },
    });
    await app.ready();
    await app.close();
    const liveSet = new Set(
      live.routes
        .filter((r) => r.method !== "HEAD" && r.method !== "OPTIONS")
        .map((r) => `${r.method} ${r.url}`),
    );
    const table = new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`));
    expect([...liveSet].filter((x) => !table.has(x)).sort(), "routes missing from openapi-routes.ts").toEqual(
      [],
    );
    // A table entry with no live route must say why (`conditional`): "not wired" routes exist as code but are not registered yet.
    const conditional = new Set(
      ROUTES.filter((r) => r.conditional).map((r) => `${r.method.toUpperCase()} ${r.path}`),
    );
    expect(
      [...table].filter((x) => !liveSet.has(x) && !conditional.has(x)).sort(),
      "table entries with no live route",
    ).toEqual([]);
  }, 180_000);

  it("the committed docs/api files equal the generated output (run `pnpm api:openapi` to refresh)", () => {
    for (const [name, content] of Object.entries(generatedFiles())) {
      const p = join(DOCS_API_DIR, name);
      expect(existsSync(p), `${name} missing`).toBe(true);
      expect(readFileSync(p, "utf8") === content, `docs/api/${name} is out of date`).toBe(true);
    }
  });

  it("the spec is structurally valid OpenAPI 3.1: unique operationIds, every $ref resolves, a success response each", () => {
    const spec = buildSpec();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.version).toBe(CONTRACTS_VERSION);
    const ids = new Set<string>();
    const refs: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          if (k === "$ref" && typeof x === "string") refs.push(x);
          else walk(x);
        }
    };
    let ops = 0;
    for (const [path, item] of Object.entries(spec.paths))
      for (const [method, op] of Object.entries(
        item as Record<string, { operationId: string; responses: Record<string, unknown> }>,
      )) {
        ops++;
        expect(ids.has(op.operationId), `duplicate operationId ${op.operationId}`).toBe(false);
        ids.add(op.operationId);
        expect(
          Object.keys(op.responses).some((c) => /^2\d\d$/.test(c)),
          `${method} ${path} has no 2xx`,
        ).toBe(true);
      }
    walk(spec);
    const schemas = spec.components.schemas as Record<string, unknown>;
    for (const r of refs) {
      const m = /^#\/components\/schemas\/([A-Za-z0-9_]+)$/.exec(r);
      expect(m, `unsupported $ref ${r}`).not.toBeNull();
      expect(schemas[m![1]!], `unresolved $ref ${r}`).toBeDefined();
    }
    expect(ops).toBe(ROUTES.length);
    expect(Object.keys(spec.paths).every((p) => !p.includes(":"))).toBe(true);
    for (const r of ROUTES) expect(spec.paths[toOas(r.path)]?.[r.method]).toBeDefined();
  });

  it("every route the metric-routes plugin declares is in the route table", () => {
    const src = readFileSync(join(import.meta.dirname, "../src/metric-routes.ts"), "utf8");
    const declared = [...src.matchAll(/app\.(get|post|put|delete)<[^>]*>\(\s*"([^"]+)"/g)].map(
      (m) => `${m[1]!.toUpperCase()} ${m[2]}`,
    );
    expect(declared.length).toBeGreaterThanOrEqual(14);
    const table = new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`));
    expect(declared.filter((x) => !table.has(x))).toEqual([]);
  });

  it("covers every s21 capability with at least one operation, or declares it as not yet routed", () => {
    const caps = new Set(
      ROUTES.map((r) => r.capability ?? "")
        .join(",")
        .split(/,\s*/),
    );
    for (const c of [
      "source discovery",
      "entity registry",
      "historical coverage",
      "chart data",
      "source provenance",
      "drilldown",
      "investigation progress",
      "agent task state",
      "research findings",
      "evidence graph",
      "historical snapshots",
      "monitoring",
      "publications",
      "spend and budget status",
      "streaming update events",
      "result annotations",
      "certified metric catalogue",
      "draft metric proposals",
    ])
      expect(caps.has(c), `capability ${c} has no operation`).toBe(true);
  });
});

describe("state and error taxonomy", () => {
  it("has exactly the twelve states of final_master_prompt s21", () => {
    expect([...API_STATES].sort()).toEqual(
      [
        "loading",
        "partial",
        "complete",
        "stale",
        "truncated",
        "source_unavailable",
        "permission_denied",
        "rate_limited",
        "insufficient_data",
        "metric_uncertified",
        "method_unvalidated",
        "budget_exhausted",
      ].sort(),
    );
    expect(Object.keys(API_STATE_INFO).sort()).toEqual([...API_STATES].sort());
  });

  it("maps every reason code the code base can emit, or explicitly leaves it stateless", () => {
    const reasons = [
      "TOO_MANY_LOGINS",
      "TOO_MANY_REQUESTS",
      "TENANT_QUEUE_FULL",
      "GLOBAL_QUEUE_FULL",
      "QUEUE_TIMEOUT",
      "QUEUE_EVICTED",
      "TOO_MANY_STREAMS",
      "ACCESS_DENIED",
      "INSUFFICIENT_ROLE",
      "ORIGIN_NOT_ALLOWED",
      "ROLE_CANNOT_PUBLISH",
      "ROLE_CANNOT_CLASSIFY",
      "INVALID_SESSION",
      "MISSING_SESSION",
      "SESSION_REVOKED",
      "NO_MEMBERSHIP",
      "UNKNOWN_SUBJECT",
      "INVALID_GATEWAY_CREDENTIAL",
      "APPROVAL_MISSING",
      "BUDGET_EXCEEDED",
      "CAP_REACHED",
      "DIMENSION_LIMIT",
      "HARD_STOPPED",
      "PAID_OP_NOT_PERMITTED",
      "GLOBAL_CEILING",
      "PRICE_UNKNOWN",
      "SOURCE_UNAVAILABLE",
      "CUBE_UNAVAILABLE",
      "CANNOT_COMPUTE",
    ];
    for (const r of reasons) expect(REASON_CODE_STATE[r], r).toBeDefined();
    // every ErrorCode resolves to a state or is a known stateless code
    const statelessCodes = new Set([
      "STALE_VERSION",
      "VALIDATION_FAILED",
      "DOMAIN_INVARIANT",
      "NOT_FOUND",
      "INTERNAL",
    ]);
    for (const c of ErrorCode.options)
      expect(stateOfError(c) !== undefined || statelessCodes.has(c), c).toBe(true);

    // scan the real sources for reason codes raised as KernelError / OverloadError / CostBlockReason and require classification
    const roots = ["../../../packages/kernel/src", "../src", "../../../packages/agent-runtime/src"];
    const found = new Set<string>();
    const scan = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) scan(p);
        else if (p.endsWith(".ts"))
          for (const m of readFileSync(p, "utf8").matchAll(/KernelError\(\s*"([A-Z_]+)",\s*"([A-Z_0-9]+)"/g))
            found.add(`${m[1]}/${m[2]}`);
      }
    };
    for (const r of roots) scan(join(import.meta.dirname, r));
    expect(found.size).toBeGreaterThan(40);
    // Every (errorCode, reasonCode) the code raises is either classified, or its errorCode is one of the stateless kinds
    // (validation, concurrency, not found, internal): a refusal of another kind must be added to REASON_CODE_STATE.
    const unclassified = [...found]
      .map((x) => x.split("/") as [string, string])
      .filter(
        ([c, r]) => stateOfError(c, r) === undefined && !statelessCodes.has(c) && c !== "DOMAIN_INVARIANT",
      )
      .map((x) => x.join("/"))
      .sort();
    expect(unclassified, "errors neither mapped to a state nor of a stateless kind").toEqual([]);
    // DOMAIN_INVARIANT reasons are reviewed one by one: each is either mapped or listed here as stateless on purpose.
    const reviewedStateless = new Set([
      "BRANCH_NOT_ACTIVE",
      "DUPLICATE_EDGE",
      "NO_ACTIVE_BRANCH",
      "NO_TARGET",
      "NODE_TOMBSTONED",
      "NOTHING_TO_DELETE",
      "PROPOSAL_CLOSED",
      "PUBLICATION_BLOCKED",
      "RUN_NOT_CANCELLABLE",
      "ACKNOWLEDGEMENT_REQUIRED",
      "REFERENCE_THESIS_OFFLINE",
      "THESIS_HAS_NO_HYPOTHESIS",
      "TEST_PLAN_LOCK_INVALID",
      "ABI_MAJOR_CHANGE_REQUIRES_MIGRATION",
      "ALREADY_INSTALLED",
      "ANOTHER_VERSION_ACTIVE",
      "BRANCH_EXISTS",
      "CAPSULE_NOT_REPRODUCIBLE_FROM_SNAPSHOT",
      "DEPENDENCY_MISSING",
      "EVIDENCE_NOT_FOUND",
      "EXPERIMENT_INTEGRITY_FAILED",
      "HYPOTHESIS_FROZEN",
      "HYPOTHESIS_NOT_FROZEN",
      "IDEMPOTENCY_KEY_REUSED",
      "INVITE_ALREADY_ACCEPTED",
      "INVITE_EXPIRED",
      "INVITE_REVOKED",
      "LAST_OWNER",
      "TEMPLATE_KEY_EXISTS",
      "TEMPLATE_KEY_RESERVED",
      "INVALID_MARKER_TRANSITION",
      "INVALID_STATE_TRANSITION",
      "MARKER_NOT_ACTIVE",
      "MARKER_NOT_DELETABLE",
      "MEMORY_CANNOT_UPGRADE_CONFIDENCE",
      "MERGE_CONFLICTS_UNRESOLVED",
      "MONITOR_RULE_REQUIRED",
      "NO_PREVIOUS_VERSION",
      "PLUGIN_NOT_AVAILABLE",
      "PUBLISH_MANIFEST_INVALID",
      "RAW_OBJECT_SHARED",
      "REPLAY_FAILED",
      "RESEARCH_RUN_HASH_MISMATCH",
      "RESPONSE_BINDING_MISMATCH",
      "SUMMARY_WITHOUT_SOURCE",
      "UPGRADE_NEEDS_OUT_OF_SAMPLE_EVIDENCE",
    ]);
    const domain = [...found].filter((x) => x.startsWith("DOMAIN_INVARIANT/")).map((x) => x.split("/")[1]!);
    const unreviewed = domain.filter((r) => !REASON_CODE_STATE[r] && !reviewedStateless.has(r)).sort();
    expect(unreviewed).toEqual([]);
  });

  it("is additive: an old client's ErrorResponse (no state) still parses; new errors carry state", () => {
    const old = {
      traceId: "t-1",
      errorCode: "RATE_LIMITED",
      reasonCode: "TOO_MANY_REQUESTS",
      message: "x",
      retryable: true,
      retryAfterSeconds: 5,
    };
    expect(ErrorResponse.safeParse(old).success).toBe(true);
    const limited = toErrorResponse(
      new KernelError("RATE_LIMITED", "TOO_MANY_REQUESTS", "slow down"),
      "trace-123456",
    );
    expect(limited.status).toBe(429);
    expect(limited.body.state).toBe("rate_limited");
    const forbidden = toErrorResponse(
      new KernelError("FORBIDDEN", "ROLE_CANNOT_PUBLISH", "no"),
      "trace-123456",
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.state).toBe("permission_denied");
    const validation = toErrorResponse(
      new KernelError("VALIDATION_FAILED", "INVALID_BODY", "bad"),
      "trace-123456",
    );
    expect(validation.status).toBe(422);
    expect("state" in validation.body).toBe(false);
    expect(ApiState.safeParse("nope").success).toBe(false);
  });
});

describe("examples and fixtures validate against the contracts", () => {
  const ex = (rel: string) =>
    JSON.parse(readFileSync(join(DOCS_API_DIR, "examples", rel), "utf8")) as unknown;
  const table: Array<[string, { safeParse(v: unknown): { success: boolean; error?: unknown } }]> = [
    ["workspace-created.json", CreateWorkspaceResponse],
    ["command-accepted.json", CommandAccepted],
    ["question-accepted.json", SubmitQuestionResponse],
    ["runs-list.json", RunListResponse],
    ["sources-list.json", SourceListResponse],
    ["cost-burn.json", WorkspaceBurn],
    ["cost-ledger.json", LedgerExport],
    ["cost-reconciliation.json", WorkspaceReconciliation],
    ["cost-global.json", GlobalSpendStatus],
    ["charts/SYNTHETIC-chart-complete.json", ChartData],
    ["charts/SYNTHETIC-chart-truncated.json", ChartData],
    ["charts/SYNTHETIC-chart-stale.json", ChartData],
    ["charts/SYNTHETIC-chart-partial.json", ChartData],
  ];
  for (const [file, schema] of table)
    it(`${file}`, () => {
      const r = schema.safeParse(ex(file));
      expect(r.success, JSON.stringify(r.error)).toBe(true);
    });

  it("every error example is an ErrorResponse; every refusal state has one", () => {
    const dir = join(DOCS_API_DIR, "examples", "errors");
    const states = new Set<string>();
    for (const f of readdirSync(dir)) {
      const body = ex(`errors/${f}`);
      const r = ErrorResponse.safeParse(body);
      expect(r.success, `${f}: ${JSON.stringify(r.error)}`).toBe(true);
      const b = body as { errorCode: string; reasonCode?: string; state?: string };
      // the example state is exactly what the server derives from the codes
      expect(b.state, f).toBe(stateOfError(b.errorCode, b.reasonCode));
      if (b.state) states.add(b.state);
    }
    for (const s of [
      "source_unavailable",
      "permission_denied",
      "rate_limited",
      "insufficient_data",
      "metric_uncertified",
      "method_unvalidated",
      "budget_exhausted",
    ])
      expect(states.has(s), `no error example for ${s}`).toBe(true);
  });

  it("every data-state example is a DataStateEnvelope and the five data states are all present", () => {
    const got = new Set<string>();
    for (const f of readdirSync(join(DOCS_API_DIR, "examples", "states"))) {
      const r = DataStateEnvelope.safeParse(ex(`states/${f}`));
      expect(r.success, `${f}: ${JSON.stringify(r.error)}`).toBe(true);
      got.add((ex(`states/${f}`) as { state: string }).state);
    }
    expect([...got].sort()).toEqual(["complete", "loading", "partial", "stale", "truncated"]);
  });

  it("the SSE sample transcript parses and every frame validates against the catalogue schema", () => {
    const text = readFileSync(join(DOCS_API_DIR, "examples", "sse-session.txt"), "utf8");
    const frames = text
      .split("\n\n")
      .map((b) => b.split("\n").filter((l) => !l.startsWith(":") && l.length))
      .filter((l) => l.length);
    expect(frames.length).toBeGreaterThanOrEqual(5);
    const byName = new Map(SSE_EVENTS.map((e) => [e.event, e]));
    let lastSeq = 40;
    for (const lines of frames) {
      const event = lines.find((l) => l.startsWith("event: "))!.slice(7);
      const data = JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6)) as unknown;
      const id = lines.find((l) => l.startsWith("id: "))?.slice(4);
      const spec = byName.get(event);
      expect(spec, `event ${event} not in the catalogue`).toBeDefined();
      const schema = SSE_SCHEMAS[spec!.schema as keyof typeof SSE_SCHEMAS];
      const r = schema.safeParse(data);
      expect(r.success, `${event}: ${JSON.stringify(r.error)}`).toBe(true);
      expect(id !== undefined, `${event} id presence`).toBe(spec!.hasId);
      if (id !== undefined) {
        expect(Number(id)).toBeGreaterThan(lastSeq); // strictly increasing, coalesced id = toSeq
        lastSeq = Number(id);
      }
    }
  });

  it("the catalogue names a schema for every domain event type and every control frame the API writes", () => {
    const src = readFileSync(join(import.meta.dirname, "../src/app.ts"), "utf8");
    for (const f of ["coalesced", "reload_required", "session_expired"]) {
      expect(src.includes(`frame("${f}"`), `app.ts no longer writes ${f}`).toBe(true);
      expect(SSE_EVENTS.some((e) => e.event === f)).toBe(true);
    }
    for (const e of SSE_EVENTS) expect(Object.keys(SSE_SCHEMAS)).toContain(e.schema);
  });

  it("cost policy bodies accept the new requirePriceFor and reject unknown dimensions", () => {
    expect(CostPolicyBody.safeParse({ capUsd: 5, requirePriceFor: ["bigquery_bytes_billed"] }).success).toBe(
      true,
    );
    expect(CostPolicyBody.safeParse({ capUsd: 5, requirePriceFor: ["gold"] }).success).toBe(false);
  });
});
