import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { DomainEvent, InferenceProvider } from "@nearesis/contracts";
import type { Session } from "./auth.ts";
import type { Db } from "./db/pool.ts";
import { KernelError } from "./errors.ts";
import { writeAudit } from "./journal.ts";

/** ch.12: private prompts and evidence carry a label; the default for anything unlabelled is `private`. */
export type DataLabel = "private" | "internal" | "public";
export type ClassifiedSubjectKind = "evidence_node" | "snapshot" | "panel_field" | "note" | "draft";

const RANK: Record<DataLabel, number> = { public: 0, internal: 1, private: 2 };
export const maxLabel = (...labels: DataLabel[]): DataLabel =>
  labels.reduce<DataLabel>((a, b) => (RANK[b] > RANK[a] ? b : a), "public");

export function classificationDenied(sink: string, label: DataLabel): KernelError {
  return new KernelError(
    "FORBIDDEN",
    "CLASSIFICATION_DENIED",
    `${label} content may not be sent to ${sink}.`,
    { retryable: false },
  );
}

/** Labels are stored per subject; reading a subject without a label yields `private`. */
export class ClassificationService {
  constructor(private readonly db: Db) {}

  async set(
    session: Session,
    workspaceId: string,
    kind: ClassifiedSubjectKind,
    id: string,
    label: DataLabel,
  ): Promise<void> {
    if (session.role === "viewer")
      throw new KernelError("FORBIDDEN", "ROLE_CANNOT_CLASSIFY", "Viewers cannot change labels.");
    await this.db.tx(
      { orgId: session.principal.orgId, userId: session.userId, actorKind: session.principal.kind },
      async (tx) => {
        const ws = await tx.query<{ org_id: string }>("SELECT org_id FROM workspaces WHERE id = $1", [
          workspaceId,
        ]);
        if (!ws.rows[0]) throw new KernelError("NOT_FOUND", "WORKSPACE_NOT_FOUND", "Workspace not found.");
        await tx.query(
          `INSERT INTO data_classifications(org_id, workspace_id, subject_kind, subject_id, label, set_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (workspace_id, subject_kind, subject_id) DO UPDATE SET label = EXCLUDED.label, set_by = EXCLUDED.set_by, set_at = now()`,
          [ws.rows[0].org_id, workspaceId, kind, id, label, session.userId],
        );
        await writeAudit(tx, {
          orgId: ws.rows[0].org_id,
          workspaceId,
          actorId: session.userId,
          action: "classification.set",
          subject: `${kind}:${id}`,
          outcome: "ok",
          detail: { label },
        });
      },
    );
  }

  async labelsOf(
    session: Session,
    workspaceId: string,
    kind: ClassifiedSubjectKind,
  ): Promise<Map<string, DataLabel>> {
    const r = await this.db.tx(
      { orgId: session.principal.orgId, userId: session.userId, actorKind: session.principal.kind },
      (tx) =>
        tx.query<{ subject_id: string; label: DataLabel }>(
          "SELECT subject_id, label FROM data_classifications WHERE workspace_id = $1 AND subject_kind = $2",
          [workspaceId, kind],
        ),
    );
    return new Map(r.rows.map((x) => [x.subject_id, x.label]));
  }
}

export interface ClassificationPolicyOptions {
  /** Provider ids that may receive private or internal content (e.g. the attested NEAR AI path). */
  approvedModelBindings: string[];
}

/** Egress rules per sink. Only `public` content leaves for an unapproved model, public telemetry or broad fan-out. */
export class ClassificationPolicy {
  private readonly approved: Set<string>;
  constructor(o: ClassificationPolicyOptions) {
    this.approved = new Set(o.approvedModelBindings);
  }
  allowsModel(binding: string, label: DataLabel): boolean {
    return label === "public" || this.approved.has(binding);
  }
  allowsTelemetry(label: DataLabel): boolean {
    return label === "public";
  }
}

// ---- model egress -------------------------------------------------------------------------------------------------

const labelContext = new AsyncLocalStorage<DataLabel>();
/** Declares the label of the prompts built inside `fn`. Anything not declared is treated as `private`. */
export const withDataLabel = <T>(label: DataLabel, fn: () => T): T => labelContext.run(label, fn);
export const currentDataLabel = (): DataLabel => labelContext.getStore() ?? "private";

export interface GuardRefusal {
  binding: string;
  label: DataLabel;
  operation: "generateStructured" | "streamText";
}
export interface GuardOptions {
  /** Called for every refusal, in addition to the structured log line. Never receives prompt content. */
  onRefuse?: (r: GuardRefusal) => void;
}

const GUARDED = Symbol.for("nearesis.guardedInference");
/** True for a provider returned by `guardInference` (used by tests that prove no production path is unguarded). */
export const isGuardedInference = (p: InferenceProvider): boolean =>
  (p as unknown as Record<symbol, unknown>)[GUARDED] === true;

/** Binding ids that may receive private content unless configuration says otherwise (ADR-20261112-001 decision 5). */
/** Wrapper binding that forwards to an inner guarded provider (see `modelPolicyFromEnv`). */
export const ROUTED_BINDING = "ledger";
export const DEFAULT_APPROVED_MODEL_BINDINGS = ["near-ai", "openrouter", "mock", "scripted"] as const;

/**
 * The production egress policy. `NEARESIS_APPROVED_MODEL_BINDINGS` (comma separated provider ids) replaces the default
 * list, so an operator can narrow private egress to the attested NEAR AI path only; every other binding is then refused
 * for anything not declared `public`.
 */
export function modelPolicyFromEnv(
  env: (n: string) => string | undefined = (n) => process.env[n],
): ClassificationPolicy {
  const raw = env("NEARESIS_APPROVED_MODEL_BINDINGS");
  const list = raw
    ? raw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [...DEFAULT_APPROVED_MODEL_BINDINGS];
  // `ledger` is the exactly-once wrapper around LedgerInference: it makes no request itself and forwards to the guarded
  // provider underneath, which is checked against the real binding id.
  return new ClassificationPolicy({ approvedModelBindings: [...list, ROUTED_BINDING] });
}

/**
 * Wraps an inference provider so a call whose label is not allowed for this provider is refused BEFORE any request is
 * built or sent. The label comes from `withDataLabel`; a call outside it counts as `private`. A refusal is logged as one
 * structured line (binding, label and operation only, never content) and surfaces as a typed `CLASSIFICATION_DENIED`
 * KernelError (FORBIDDEN, not retryable).
 */
export function guardInference(
  provider: InferenceProvider,
  policy: ClassificationPolicy,
  options: GuardOptions = {},
): InferenceProvider {
  const check = (operation: GuardRefusal["operation"]) => {
    const label = currentDataLabel();
    if (policy.allowsModel(provider.id, label)) return;
    const refusal: GuardRefusal = { binding: provider.id, label, operation };
    process.stderr.write(
      JSON.stringify({ msg: "inference.refused", reasonCode: "CLASSIFICATION_DENIED", ...refusal }) + "\n",
    );
    try {
      options.onRefuse?.(refusal);
    } catch {
      // a failing observer must not turn a refusal into a send
    }
    throw classificationDenied(`the unapproved model binding ${provider.id}`, label);
  };
  const guarded: InferenceProvider = {
    id: provider.id,
    health: () => provider.health(),
    listModels: () => provider.listModels(),
    verifyResponse: (r) => provider.verifyResponse(r),
    generateStructured: async (a) => {
      check("generateStructured");
      return provider.generateStructured(a);
    },
    streamText: (a) => {
      check("streamText");
      return provider.streamText(a);
    },
  };
  Object.defineProperty(guarded, GUARDED, { value: true, enumerable: false });
  return guarded;
}

// ---- broad fan-out ------------------------------------------------------------------------------------------------

const STRUCTURAL_KEYS = new Set([
  "change",
  "nodeId",
  "kind",
  "panelId",
  "snapshotId",
  "branchId",
  "revision",
  "documentRevision",
  "commandType",
  "restricted",
]);
const STRUCTURAL_VALUE = /^[A-Za-z0-9._:-]{1,80}$/;

/**
 * Minimal copy of an event for consumers outside the workspace: identifiers, change type and enum values only. Free text
 * (labels, notes, prompts, data bodies) never appears, whatever its label.
 */
export function fanoutEvent(e: DomainEvent): DomainEvent {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e.data ?? {})) {
    if (!STRUCTURAL_KEYS.has(k)) continue;
    if (typeof v === "number" || typeof v === "boolean") data[k] = v;
    else if (typeof v === "string" && STRUCTURAL_VALUE.test(v)) data[k] = v;
  }
  return { ...e, data };
}

// ---- telemetry ----------------------------------------------------------------------------------------------------

/** A value explicitly cleared for public telemetry. */
export class PublicValue {
  constructor(readonly value: string) {}
}
export const publicValue = (v: string): PublicValue => new PublicValue(v);
export type TelemetryAttr = string | number | boolean | PublicValue;

const CONTENT_KEYS = /prompt|completion|content|message|note|draft|evidence|label|text|body|secret|token/i;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number }>;

/**
 * OTLP/HTTP JSON span exporter. Numbers and booleans pass. A string passes only when wrapped with `publicValue` AND its
 * attribute name is not a content-bearing name; every other string is replaced by a marker, so a prompt or workspace
 * text cannot reach a telemetry backend by being passed carelessly.
 */
export class TelemetryExporter {
  readonly withheld: string[] = [];
  /** Spans discarded because the buffer was full (collector down for long). */
  dropped = 0;
  private spans: unknown[] = [];
  constructor(
    private readonly endpoint: string,
    private readonly serviceName = "nearesis",
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i) as Promise<{ status: number }>,
    private readonly maxBuffered = 2000,
  ) {}

  get buffered(): number {
    return this.spans.length;
  }

  span(name: string, attrs: Record<string, TelemetryAttr>): void {
    const attributes = Object.entries(attrs).map(([key, v]) => {
      let out:
        { stringValue: string } | { intValue: string } | { boolValue: boolean } | { doubleValue: number };
      if (typeof v === "number") out = Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
      else if (typeof v === "boolean") out = { boolValue: v };
      else if (v instanceof PublicValue && !CONTENT_KEYS.test(key)) out = { stringValue: v.value };
      else {
        if (this.withheld.length < 1000) this.withheld.push(key);
        out = {
          stringValue: v instanceof PublicValue ? "[withheld:content-attribute]" : "[withheld:unlabelled]",
        };
      }
      return { key, value: out };
    });
    const now = BigInt(Date.now()) * 1_000_000n;
    // a valid OTLP span: 16-byte trace id, 8-byte span id, server kind and a start/end time
    this.spans.push({
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      name,
      kind: 1,
      startTimeUnixNano: String(now),
      endTimeUnixNano: String(now),
      attributes,
    });
    if (this.spans.length > this.maxBuffered) {
      this.dropped += this.spans.length - this.maxBuffered;
      this.spans = this.spans.slice(-this.maxBuffered);
    }
  }

  /** Sends the buffered spans. A transport failure or non-2xx answer keeps them (bounded) and throws. */
  async flush(): Promise<number> {
    const spans = this.spans.splice(0);
    if (!spans.length) return 0;
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: this.serviceName } }] },
          scopeSpans: [{ scope: { name: "nearesis" }, spans }],
        },
      ],
    });
    try {
      const r = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (r.status < 200 || r.status >= 300) throw new Error(`OTLP collector answered ${r.status}`);
    } catch (e) {
      this.spans = [...spans, ...this.spans].slice(-this.maxBuffered);
      throw e;
    }
    return spans.length;
  }
}

// ---- panel export -------------------------------------------------------------------------------------------------

export interface PanelLike {
  panelId: string;
  title: string;
  dataBinding: { fields: string[]; units?: Record<string, string> };
  encoding: { tooltip?: string[] } & Record<string, unknown>;
}

/**
 * Export view of a panel. For a public audience every field not labelled `public` is dropped from the data binding and the
 * tooltip list (unlabelled fields are private); members see the panel unchanged.
 */
export function panelExportView<P extends PanelLike>(
  panel: P,
  labelOf: (field: string) => DataLabel,
  audience: "member" | "public",
): P {
  if (audience === "member") return panel;
  const keep = (f: string) => labelOf(f) === "public";
  const fields = panel.dataBinding.fields.filter(keep);
  const units = Object.fromEntries(Object.entries(panel.dataBinding.units ?? {}).filter(([f]) => keep(f)));
  return {
    ...panel,
    dataBinding: { ...panel.dataBinding, fields, units },
    encoding: {
      ...panel.encoding,
      ...(panel.encoding.tooltip ? { tooltip: panel.encoding.tooltip.filter(keep) } : {}),
    },
  };
}
