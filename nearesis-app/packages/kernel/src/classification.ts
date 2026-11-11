import { AsyncLocalStorage } from "node:async_hooks";
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

/**
 * Wraps an inference provider so a call whose label is not allowed for this provider is refused BEFORE any request is
 * built or sent. The label comes from `withDataLabel`; a call outside it counts as `private`.
 */
export function guardInference(provider: InferenceProvider, policy: ClassificationPolicy): InferenceProvider {
  const check = () => {
    const label = currentDataLabel();
    if (!policy.allowsModel(provider.id, label))
      throw classificationDenied(`the unapproved model binding ${provider.id}`, label);
  };
  return {
    id: provider.id,
    health: () => provider.health(),
    listModels: () => provider.listModels(),
    verifyResponse: (r) => provider.verifyResponse(r),
    generateStructured: async (a) => {
      check();
      return provider.generateStructured(a);
    },
    streamText: (a) => {
      check();
      return provider.streamText(a);
    },
  };
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
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

/**
 * OTLP/HTTP JSON span exporter. Numbers and booleans pass. A string passes only when wrapped with `publicValue` AND its
 * attribute name is not a content-bearing name; every other string is replaced by a marker, so a prompt or workspace
 * text cannot reach a telemetry backend by being passed carelessly.
 */
export class TelemetryExporter {
  readonly withheld: string[] = [];
  private readonly spans: unknown[] = [];
  constructor(
    private readonly endpoint: string,
    private readonly serviceName = "nearesis",
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i) as Promise<{ status: number }>,
  ) {}

  span(name: string, attrs: Record<string, TelemetryAttr>): void {
    const attributes = Object.entries(attrs).map(([key, v]) => {
      let out:
        { stringValue: string } | { intValue: string } | { boolValue: boolean } | { doubleValue: number };
      if (typeof v === "number") out = Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
      else if (typeof v === "boolean") out = { boolValue: v };
      else if (v instanceof PublicValue && !CONTENT_KEYS.test(key)) out = { stringValue: v.value };
      else {
        this.withheld.push(key);
        out = {
          stringValue: v instanceof PublicValue ? "[withheld:content-attribute]" : "[withheld:unlabelled]",
        };
      }
      return { key, value: out };
    });
    this.spans.push({ name, attributes });
  }

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
    await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
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
