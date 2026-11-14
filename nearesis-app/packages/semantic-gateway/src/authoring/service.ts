import { randomUUID } from "node:crypto";
import {
  AuthoredStoreError,
  canonicalJson,
  proposalHash,
  sha256,
  type AuthoredMetricStore,
  type AuthoringScope,
  type ClickHouseClient,
  type Registry,
} from "@nearesis/analytics";
import {
  EXPLORATORY_BANNER,
  MetricProposal,
  type DataFrameEnvelope,
  type MetricCheck,
  type MetricIssue,
  type MetricRecord,
  type MetricValidationReport,
  type MetricVersionPin,
  type Role,
} from "@nearesis/contracts";
import type { SourceCatalogue } from "./catalogue.ts";
import { compileProposal, type CompiledPlan } from "./compiler.ts";
import { MetricAuthoringError } from "./errors.ts";
import {
  bucketCoverages,
  estimateCost,
  executePlan,
  latestCoveredDay,
  reconcile,
  runDeclaredTests,
  sampleWindow,
  daysBetween,
  alignWindow,
  type RunLimits,
  type Window,
} from "./run.ts";
import { loadWatermarks } from "../coverage.ts";

/** The caller as the authoring service sees it. Resolved server-side from the kernel session, never from a body. */
export interface AuthoringPrincipal {
  id: string;
  kind: "human" | "agent" | "service";
  /** Membership role of the human (or the human an agent acts for). null when unknown. */
  role: Role | null;
  tenantId: string;
  workspaceId: string;
}

export interface AuthoringPolicy {
  maxEstimatedRows: number;
  maxExecutionSeconds: number;
  /** Roles that may certify or deprecate. Only a HUMAN principal holding one of these may; no agent ever can. */
  certifierRoles: Role[];
  /** If false (default) a human cannot certify a metric they authored themselves. */
  allowSelfCertification: boolean;
  maxValidationAgeMs: number;
  exploration: { draft: boolean; validated: boolean; roles: Role[]; agents: boolean };
  proposerRoles: Role[];
}

export const DEFAULT_AUTHORING_POLICY: AuthoringPolicy = {
  maxEstimatedRows: 5_000_000,
  maxExecutionSeconds: 20,
  certifierRoles: ["owner", "admin"],
  allowSelfCertification: false,
  maxValidationAgeMs: 7 * 86_400_000,
  exploration: { draft: true, validated: true, roles: ["owner", "admin", "analyst"], agents: true },
  proposerRoles: ["owner", "admin", "analyst"],
};

export interface AuthoringDeps {
  store: AuthoredMetricStore;
  ch: ClickHouseClient;
  /** Returns the current generated catalogue (cached by the caller). */
  catalogue: () => Promise<SourceCatalogue>;
  /** Static, certified registry (`live.*`, fixtures): valid dependency targets and catalogue entries. */
  registry?: Registry | undefined;
  clock?: () => Date;
  policy?: Partial<AuthoringPolicy>;
  /** Semantic version echoed in envelopes (defaults to the registry's, else 1.0.0). */
  semanticVersion?: string;
}

const key = (p: { namespace: string; name: string }) => `${p.namespace}.${p.name}`;

export interface ProposeResult {
  record: MetricRecord;
  report: MetricValidationReport | null;
}

export function createAuthoringService(deps: AuthoringDeps) {
  const clock = deps.clock ?? (() => new Date());
  const policy: AuthoringPolicy = { ...DEFAULT_AUTHORING_POLICY, ...deps.policy };
  const store = deps.store;
  const scopeOf = (p: AuthoringPrincipal): AuthoringScope => ({
    tenantId: p.tenantId,
    workspaceId: p.workspaceId,
  });

  const refuse = async (
    p: AuthoringPrincipal,
    action: string,
    metricKey: string,
    version: number | null,
    e: MetricAuthoringError,
  ) => {
    await store
      .audit(scopeOf(p), {
        metricKey,
        version,
        action,
        outcome: "refused",
        actorId: p.id,
        actorKind: p.kind,
        actorRole: p.role ?? undefined,
        detail: { reason: e.reason, message: e.message },
      })
      .catch(() => undefined);
    return e;
  };
  const ok = (
    p: AuthoringPrincipal,
    action: string,
    metricKey: string,
    version: number | null,
    detail: Record<string, unknown> = {},
  ) =>
    store.audit(scopeOf(p), {
      metricKey,
      version,
      action,
      outcome: "ok",
      actorId: p.id,
      actorKind: p.kind,
      actorRole: p.role ?? undefined,
      detail,
    });

  const mayPropose = (p: AuthoringPrincipal) =>
    p.kind !== "human" || (p.role !== null && policy.proposerRoles.includes(p.role));
  const isCertifier = (p: AuthoringPrincipal) =>
    p.kind === "human" && p.role !== null && policy.certifierRoles.includes(p.role);

  const getOrThrow = async (p: AuthoringPrincipal, k: string, version: number): Promise<MetricRecord> => {
    const r = await store.get(scopeOf(p), k, version);
    if (!r) throw new MetricAuthoringError("NOT_FOUND", "No such metric version.");
    return r;
  };

  const limits = (maxRows: number): RunLimits => ({
    maxEstimatedRows: maxRows,
    maxExecutionSeconds: policy.maxExecutionSeconds,
    maxRowsToRead: Math.max(1_000_000, Math.ceil(maxRows * 2)),
  });

  async function dependencyIssues(p: AuthoringPrincipal, proposal: MetricProposal): Promise<MetricIssue[]> {
    const out: MetricIssue[] = [];
    for (const [i, d] of proposal.dependencies.entries()) {
      const [k, v] = d.split("@") as [string, string];
      const reg = deps.registry?.metrics.find((m) => m.id === k);
      if (reg) {
        if (!reg.certified || Number(reg.certifiedVersion.split(".")[0]) !== Number(v))
          out.push({
            reason: "DEPENDENCY_NOT_CERTIFIED",
            path: `dependencies[${i}]`,
            message: `${d} is not the certified registry version.`,
          });
        continue;
      }
      const rec = await store.get(scopeOf(p), k, Number(v));
      if (!rec || rec.status !== "CERTIFIED")
        out.push({
          reason: "DEPENDENCY_NOT_CERTIFIED",
          path: `dependencies[${i}]`,
          message: `${d} is not a certified metric version.`,
        });
    }
    return out;
  }

  /** The full gate: allowlist compile, dependencies, cost, bounded execution on a sample window, raw reconciliation, declared tests. */
  async function runPipeline(
    p: AuthoringPrincipal,
    proposal: unknown,
  ): Promise<{ report: MetricValidationReport; plan: CompiledPlan | null }> {
    const cat = await deps.catalogue();
    const checks: MetricCheck[] = [];
    const issues: MetricIssue[] = [];
    const hashOf = (x: unknown) => sha256(canonicalJson(x));
    const base = (extra: Partial<MetricValidationReport>): MetricValidationReport => ({
      ok: false,
      proposalHash: hashOf(proposal),
      checks,
      issues,
      derivedUnit: null,
      cost: null,
      planFingerprint: null,
      sampleWindow: null,
      validatedAt: clock().toISOString(),
      ...extra,
    });
    const c = compileProposal(proposal, cat, { tenantId: p.tenantId });
    if (!c.ok) {
      checks.push({ name: "schema_allowlist_units", verdict: "fail", detail: `${c.issues.length} issue(s)` });
      issues.push(...c.issues);
      return { report: base({}), plan: null };
    }
    const plan = c.plan;
    checks.push({
      name: "schema_allowlist_units",
      verdict: "pass",
      detail: `unit ${plan.derivedUnit}; tables ${plan.tables.map((t) => t.table).join(", ")}`,
    });
    const dep = await dependencyIssues(p, plan.proposal);
    checks.push({
      name: "dependencies_certified",
      verdict: dep.length ? "fail" : "pass",
      detail: `${plan.proposal.dependencies.length} dependency(ies)`,
    });
    issues.push(...dep);
    if (dep.length)
      return { report: base({ derivedUnit: plan.derivedUnit, planFingerprint: plan.fingerprint }), plan };

    const maxRows = Math.min(plan.proposal.costEstimate.maxEstimatedRows, policy.maxEstimatedRows);
    const end = await latestCoveredDay(deps.ch, plan);
    if (!end) {
      checks.push({ name: "cost_estimate", verdict: "fail", detail: "no loaded coverage for a source" });
      issues.push({
        reason: "COVERAGE_UNKNOWN",
        path: "sources",
        message: "A source has no loaded coverage: cost and coverage cannot be established.",
      });
      return { report: base({ derivedUnit: plan.derivedUnit, planFingerprint: plan.fingerprint }), plan };
    }
    const win = sampleWindow(end, plan.proposal.timeGrain.grain);
    const days = daysBetween(win.from, win.to);
    const est = await estimateCost(deps.ch, plan, days);
    const cost = {
      estimatedRows: est.estimatedRows,
      maxEstimatedRows: maxRows,
      method: "coverage_rate_x_days" as const,
      windowDays: days,
    };
    if (est.unknown.length || est.estimatedRows > maxRows) {
      checks.push({
        name: "cost_estimate",
        verdict: "fail",
        detail: est.unknown.length
          ? `unknown rate for ${est.unknown.join(", ")}`
          : `${est.estimatedRows} rows > cap ${maxRows}`,
      });
      issues.push({
        reason: est.unknown.length ? "COVERAGE_UNKNOWN" : "COST_CAP",
        path: "costEstimate",
        message: `Estimated ${est.estimatedRows} rows exceeds the cap of ${maxRows}.`,
      });
      return {
        report: base({
          derivedUnit: plan.derivedUnit,
          planFingerprint: plan.fingerprint,
          cost,
          sampleWindow: win,
        }),
        plan,
      };
    }
    checks.push({
      name: "cost_estimate",
      verdict: "pass",
      detail: `${est.estimatedRows} rows over ${days} day(s), cap ${maxRows}`,
    });

    let series;
    try {
      series = await executePlan(deps.ch, plan, win, limits(maxRows));
      checks.push({
        name: "bounded_execution",
        verdict: "pass",
        detail: `${series.rows.length} bucket(s) over ${win.from}..${win.to}, readonly, bounded`,
      });
    } catch (e) {
      checks.push({ name: "bounded_execution", verdict: "fail", detail: (e as Error).message.slice(0, 300) });
      issues.push({ reason: "EXECUTION_FAILED", path: "plan", message: (e as Error).message.slice(0, 300) });
      return {
        report: base({
          derivedUnit: plan.derivedUnit,
          planFingerprint: plan.fingerprint,
          cost,
          sampleWindow: win,
        }),
        plan,
      };
    }
    try {
      const rc = await reconcile(deps.ch, plan, win, series, limits(maxRows));
      checks.push({
        name: "reconcile_raw",
        verdict: rc.ok ? "pass" : "fail",
        detail: [...rc.failures, ...rc.details].join("; ").slice(0, 1000),
      });
      if (!rc.ok)
        issues.push({
          reason: "RECONCILIATION_FAILED",
          path: "plan",
          message: rc.failures.join("; ").slice(0, 500),
        });
    } catch (e) {
      checks.push({ name: "reconcile_raw", verdict: "fail", detail: (e as Error).message.slice(0, 300) });
      issues.push({ reason: "EXECUTION_FAILED", path: "plan", message: (e as Error).message.slice(0, 300) });
    }
    const t = runDeclaredTests(plan, series);
    checks.push(...t.checks);
    issues.push(...t.issues);
    return {
      report: base({
        ok: issues.length === 0,
        derivedUnit: plan.derivedUnit,
        planFingerprint: plan.fingerprint,
        cost,
        sampleWindow: win,
      }),
      plan,
    };
  }

  const finishValidation = async (p: AuthoringPrincipal, rec: MetricRecord): Promise<ProposeResult> => {
    const { report } = await runPipeline(p, rec.proposal);
    const saved = await store.saveValidation(
      scopeOf(p),
      rec.metricKey,
      rec.version,
      report,
      report.ok ? "VALIDATED" : "DRAFT",
    );
    await ok(p, "validate", rec.metricKey, rec.version, { ok: report.ok, issues: report.issues.length });
    return { record: saved, report };
  };

  return {
    policy,

    /** Compile-only check (no storage, no execution): what an agent calls to iterate on a proposal. */
    async check(p: AuthoringPrincipal, input: unknown) {
      const c = compileProposal(input, await deps.catalogue(), { tenantId: p.tenantId });
      return c.ok
        ? { ok: true as const, derivedUnit: c.plan.derivedUnit, fingerprint: c.plan.fingerprint, issues: [] }
        : { ok: false as const, issues: c.issues };
    },

    /** Stores a new DRAFT version (author = caller), then runs the full gate. A proposal that fails the allowlist is not stored. */
    async propose(
      p: AuthoringPrincipal,
      input: unknown,
      opts: { validate?: boolean } = {},
    ): Promise<ProposeResult> {
      const parsed = MetricProposal.safeParse(input);
      const k = parsed.success ? key(parsed.data) : "unparsed";
      if (!mayPropose(p))
        throw await refuse(
          p,
          "propose",
          k,
          null,
          new MetricAuthoringError("FORBIDDEN", "This principal may not propose metrics."),
        );
      const c = compileProposal(input, await deps.catalogue(), { tenantId: p.tenantId });
      if (!c.ok) {
        const e = new MetricAuthoringError(
          c.issues[0]?.reason ?? "INVALID_PROPOSAL",
          "The proposal was refused by the typed compiler.",
          c.issues,
        );
        throw await refuse(p, "propose", k, null, e);
      }
      const prop = c.plan.proposal;
      if (prop.author.principalId !== p.id || prop.author.kind !== p.kind) {
        const e = new MetricAuthoringError("FORBIDDEN", "author must be the calling principal.", [
          {
            reason: "FORBIDDEN",
            path: "author",
            message: "Authorship is set from the session, not the body.",
          },
        ]);
        throw await refuse(p, "propose", k, null, e);
      }
      const rec = await store.createDraft(scopeOf(p), key(prop), { id: p.id, kind: p.kind }, (version) => ({
        ...prop,
        version,
      }));
      await ok(p, "propose", rec.metricKey, rec.version, { proposalHash: rec.proposalHash });
      if (opts.validate === false) return { record: rec, report: null };
      return finishValidation(p, rec);
    },

    /** Re-runs the gate on a stored version (DRAFT or VALIDATED). */
    async validate(p: AuthoringPrincipal, metricKey: string, version: number): Promise<ProposeResult> {
      if (!mayPropose(p))
        throw await refuse(
          p,
          "validate",
          metricKey,
          version,
          new MetricAuthoringError("FORBIDDEN", "This principal may not validate metrics."),
        );
      const rec = await getOrThrow(p, metricKey, version);
      if (rec.status !== "DRAFT" && rec.status !== "VALIDATED")
        throw await refuse(
          p,
          "validate",
          metricKey,
          version,
          new MetricAuthoringError("ILLEGAL_TRANSITION", `A ${rec.status} version cannot be re-validated.`),
        );
      return finishValidation(p, rec);
    },

    /** Edit a never-certified draft in place. The status returns to DRAFT and the old validation is discarded. */
    async edit(
      p: AuthoringPrincipal,
      metricKey: string,
      version: number,
      input: unknown,
    ): Promise<ProposeResult> {
      if (!mayPropose(p))
        throw await refuse(
          p,
          "edit",
          metricKey,
          version,
          new MetricAuthoringError("FORBIDDEN", "This principal may not edit metrics."),
        );
      const rec = await getOrThrow(p, metricKey, version);
      const c = compileProposal(input, await deps.catalogue(), { tenantId: p.tenantId });
      if (!c.ok)
        throw await refuse(
          p,
          "edit",
          metricKey,
          version,
          new MetricAuthoringError(
            c.issues[0]?.reason ?? "INVALID_PROPOSAL",
            "Refused by the typed compiler.",
            c.issues,
          ),
        );
      if (key(c.plan.proposal) !== metricKey)
        throw await refuse(
          p,
          "edit",
          metricKey,
          version,
          new MetricAuthoringError("INVALID_PROPOSAL", "A version cannot change its namespace or name."),
        );
      try {
        const next = await store.replaceDefinition(scopeOf(p), metricKey, version, {
          ...c.plan.proposal,
          version,
          author: { principalId: rec.authorId, kind: rec.proposal.author.kind, tenantId: p.tenantId },
        });
        await ok(p, "edit", metricKey, version, { proposalHash: next.proposalHash });
        return finishValidation(p, next);
      } catch (e) {
        if (e instanceof AuthoredStoreError)
          throw await refuse(
            p,
            "edit",
            metricKey,
            version,
            new MetricAuthoringError(e.reason === "NOT_FOUND" ? "NOT_FOUND" : "IMMUTABLE_VERSION", e.message),
          );
        throw e;
      }
    },

    /** A definition change on a certified metric: copies it to a NEW draft version; the certified version is untouched. */
    async revise(
      p: AuthoringPrincipal,
      metricKey: string,
      fromVersion: number,
      input: unknown,
    ): Promise<ProposeResult> {
      await getOrThrow(p, metricKey, fromVersion);
      const prop = MetricProposal.safeParse(input);
      if (prop.success && key(prop.data) !== metricKey)
        throw new MetricAuthoringError(
          "INVALID_PROPOSAL",
          "A revision keeps the metric's namespace and name.",
        );
      return this.propose(p, input);
    },

    /** DRAFT/VALIDATED -> CERTIFIED. Only a human certifier; never an agent or service; never stale; never unvalidated. */
    async certify(p: AuthoringPrincipal, metricKey: string, version: number): Promise<MetricRecord> {
      const rec = await store.get(scopeOf(p), metricKey, version);
      const deny = async (e: MetricAuthoringError) => {
        throw await refuse(p, "certify", metricKey, version, e);
      };
      if (p.kind !== "human")
        return deny(
          new MetricAuthoringError(
            "HUMAN_PRINCIPAL_REQUIRED",
            "Certification needs a human principal; agents and services cannot certify.",
          ),
        );
      if (!isCertifier(p))
        return deny(
          new MetricAuthoringError(
            "CERTIFIER_REQUIRED",
            "Certification needs the certifier role (owner or admin).",
          ),
        );
      if (!rec) return deny(new MetricAuthoringError("NOT_FOUND", "No such metric version."));
      if (rec.status !== "VALIDATED")
        return deny(
          new MetricAuthoringError(
            rec.status === "DRAFT" ? "NOT_VALIDATED" : "ILLEGAL_TRANSITION",
            `Only a VALIDATED version can be certified (this one is ${rec.status}).`,
          ),
        );
      if (!policy.allowSelfCertification && rec.authorId === p.id)
        return deny(
          new MetricAuthoringError(
            "SELF_CERTIFICATION_REFUSED",
            "The author cannot certify their own metric.",
          ),
        );
      const v = rec.validation;
      if (!v || !v.ok || v.proposalHash !== proposalHash(rec.proposal) || v.proposalHash !== rec.proposalHash)
        return deny(
          new MetricAuthoringError(
            "NOT_VALIDATED",
            "The stored validation does not match the current definition.",
          ),
        );
      if (clock().getTime() - Date.parse(v.validatedAt) > policy.maxValidationAgeMs)
        return deny(
          new MetricAuthoringError("STALE_VALIDATION", "The validation is too old; validate again."),
        );
      try {
        const done = await store.certify(scopeOf(p), metricKey, version, p.id);
        await ok(p, "certify", metricKey, version, { proposalHash: done.proposalHash });
        return done;
      } catch (e) {
        if (e instanceof AuthoredStoreError)
          return deny(new MetricAuthoringError("ILLEGAL_TRANSITION", e.message));
        throw e;
      }
    },

    /**
     * -> DEPRECATED. With `correction`, the V18 flow: every snapshot that pinned this version and every authored metric that
     * depends on it is recorded as invalidated. Their stored values and pins are NOT rewritten.
     */
    async deprecate(
      p: AuthoringPrincipal,
      metricKey: string,
      version: number,
      reason: string,
      opts: { correction?: boolean } = {},
    ) {
      const deny = async (e: MetricAuthoringError) => {
        throw await refuse(p, "deprecate", metricKey, version, e);
      };
      if (p.kind !== "human")
        return deny(
          new MetricAuthoringError("HUMAN_PRINCIPAL_REQUIRED", "Deprecation needs a human principal."),
        );
      if (!isCertifier(p))
        return deny(
          new MetricAuthoringError(
            "CERTIFIER_REQUIRED",
            "Deprecation needs the certifier role (owner or admin).",
          ),
        );
      if (!(await store.get(scopeOf(p), metricKey, version)))
        return deny(new MetricAuthoringError("NOT_FOUND", "No such metric version."));
      if (reason.trim().length < 5)
        return deny(new MetricAuthoringError("INVALID_PROPOSAL", "A deprecation reason is required."));
      try {
        const rec = await store.deprecate(scopeOf(p), metricKey, version, p.id, reason);
        let invalidated: { snapshots: string[]; metrics: Array<{ metricKey: string; version: number }> } = {
          snapshots: [],
          metrics: [],
        };
        if (opts.correction) {
          invalidated = await store.dependentsOf(scopeOf(p), metricKey, version);
          await store.recordCorrections(
            scopeOf(p),
            metricKey,
            version,
            [
              ...invalidated.snapshots.map((id) => ({ kind: "snapshot" as const, id })),
              ...invalidated.metrics.map((m) => ({
                kind: "metric" as const,
                id: `${m.metricKey}@${m.version}`,
              })),
            ],
            reason,
            p.id,
          );
        }
        await ok(p, "deprecate", metricKey, version, {
          reason,
          correction: !!opts.correction,
          invalidatedSnapshots: invalidated.snapshots.length,
          invalidatedMetrics: invalidated.metrics.length,
        });
        return { record: rec, invalidated };
      } catch (e) {
        if (e instanceof AuthoredStoreError)
          return deny(new MetricAuthoringError("ILLEGAL_TRANSITION", e.message));
        throw e;
      }
    },

    get: (p: AuthoringPrincipal, k: string, v: number) => getOrThrow(p, k, v),
    versions: async (p: AuthoringPrincipal, k: string) => {
      const vs = await store.versions(scopeOf(p), k);
      if (!vs.length) throw new MetricAuthoringError("NOT_FOUND", "No such metric.");
      return {
        versions: vs,
        audit: await store.auditTrail(scopeOf(p), k),
        corrections: await store.corrections(scopeOf(p), k),
      };
    },

    /** Certified registry metrics and authored metrics (latest version of each key) with their status. */
    async catalogue(p: AuthoringPrincipal) {
      const authored = await store.list(scopeOf(p));
      return [
        ...(deps.registry?.metrics ?? []).map((m) => ({
          metricKey: m.id,
          source: "registry" as const,
          status: "CERTIFIED" as const,
          version: m.certifiedVersion,
          displayName: m.displayName,
          unit: m.unit,
          exploratory: false,
        })),
        ...authored.map((r) => ({
          metricKey: r.metricKey,
          source: "authored" as const,
          status: r.status,
          version: r.version,
          displayName: r.proposal.displayName,
          unit: r.proposal.unit,
          exploratory: r.status === "DRAFT" || r.status === "VALIDATED",
        })),
      ];
    },

    /** Pins the exact CERTIFIED versions a snapshot used. Refuses anything else. */
    async pinSnapshot(
      p: AuthoringPrincipal,
      snapshotId: string,
      refs: Array<{ metricKey: string; version: number }>,
    ): Promise<MetricVersionPin[]> {
      const pins: MetricVersionPin[] = [];
      for (const r of refs) {
        const rec = await store.get(scopeOf(p), r.metricKey, r.version);
        if (!rec || (rec.status !== "CERTIFIED" && rec.status !== "DEPRECATED") || !rec.certifiedAt)
          throw new MetricAuthoringError(
            "METRIC_NOT_CERTIFIED",
            `${r.metricKey}@${r.version} is not a certified version.`,
          );
        pins.push({ metricKey: rec.metricKey, version: rec.version, proposalHash: rec.proposalHash });
      }
      await store.pin(scopeOf(p), snapshotId, pins);
      await ok(p, "pin", refs[0]?.metricKey ?? "-", null, { snapshotId, pins: pins.length });
      return store.pinsOf(scopeOf(p), snapshotId);
    },
    pinsOf: (p: AuthoringPrincipal, snapshotId: string) => store.pinsOf(scopeOf(p), snapshotId),

    /**
     * Publication guard: every metric a published or verified artifact uses must be a CERTIFIED version. DRAFT, VALIDATED and
     * DEPRECATED versions are refused; the refusal lists each offender.
     */
    async assertPublishable(
      p: AuthoringPrincipal,
      refs: Array<{ metricKey: string; version?: number }>,
    ): Promise<void> {
      const bad: MetricIssue[] = [];
      for (const r of refs) {
        // A certified registry metric is publishable as such. A capsule records it as `<major>.0.0`: that reference is
        // accepted when it names the registry metric's own certified major version (an authored metric of the same key
        // and version, if one exists, is still checked below).
        const reg = deps.registry?.metrics.find((m) => m.id === r.metricKey && m.certified);
        if (reg && r.version === undefined) continue;
        if (
          reg &&
          r.version !== undefined &&
          Number.parseInt(String(reg.certifiedVersion).split(".")[0] ?? "", 10) === r.version &&
          !(await store.get(scopeOf(p), r.metricKey, r.version))
        )
          continue;
        const rec =
          r.version === undefined
            ? await store.currentCertified(scopeOf(p), r.metricKey)
            : await store.get(scopeOf(p), r.metricKey, r.version);
        if (!rec || rec.status !== "CERTIFIED")
          bad.push({
            reason: "METRIC_NOT_CERTIFIED",
            path: r.metricKey,
            message: `${r.metricKey}${r.version ? `@${r.version}` : ""} is ${rec ? rec.status : "unknown"}, not CERTIFIED.`,
          });
      }
      if (bad.length)
        throw new MetricAuthoringError(
          "METRIC_NOT_CERTIFIED",
          "Non-certified metrics cannot enter a published or verified artifact.",
          bad,
        );
    },

    /**
     * Executes a metric for exploration. CERTIFIED: normal result. DRAFT/VALIDATED (where policy permits): the envelope carries
     * `metricStatus` and the exploratory stamp. Never executes a draft for a viewer.
     */
    async explore(
      p: AuthoringPrincipal,
      ref: { metricKey: string; version?: number },
      range?: { from: string; to: string },
    ): Promise<{ envelope: DataFrameEnvelope; record: MetricRecord }> {
      const rec =
        ref.version === undefined
          ? ((await store.currentCertified(scopeOf(p), ref.metricKey)) ??
            (await store.versions(scopeOf(p), ref.metricKey)).at(-1) ??
            null)
          : await store.get(scopeOf(p), ref.metricKey, ref.version);
      if (!rec) throw new MetricAuthoringError("NOT_FOUND", "No such metric.");
      const exploratory = rec.status === "DRAFT" || rec.status === "VALIDATED";
      const may =
        p.kind === "agent"
          ? policy.exploration.agents
          : p.role !== null && policy.exploration.roles.includes(p.role);
      if (
        !may ||
        (rec.status === "DRAFT" && (!policy.exploration.draft || !may)) ||
        (rec.status === "VALIDATED" && !policy.exploration.validated)
      ) {
        if (exploratory || !may)
          throw await refuse(
            p,
            "explore",
            rec.metricKey,
            rec.version,
            new MetricAuthoringError(
              "EXPLORATION_NOT_PERMITTED",
              "Policy does not permit exploring this metric for this principal.",
            ),
          );
      }
      const cat = await deps.catalogue();
      const c = compileProposal(rec.proposal, cat, { tenantId: p.tenantId });
      if (!c.ok)
        throw new MetricAuthoringError(
          c.issues[0]?.reason ?? "INVALID_PROPOSAL",
          "The stored definition no longer compiles against the catalogue.",
          c.issues,
        );
      const plan = c.plan;
      const grain = plan.proposal.timeGrain.grain;
      let win: Window;
      if (range) {
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(range.from) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(range.to) ||
          range.from >= range.to
        )
          throw new MetricAuthoringError("INVALID_PROPOSAL", "range needs from < to as YYYY-MM-DD days.");
        win = alignWindow(range, grain);
      } else {
        const end = await latestCoveredDay(deps.ch, plan);
        if (!end) throw new MetricAuthoringError("COVERAGE_UNKNOWN", "A source has no loaded coverage.");
        win = sampleWindow(end, grain);
      }
      const maxRows = Math.min(plan.proposal.costEstimate.maxEstimatedRows, policy.maxEstimatedRows);
      const est = await estimateCost(deps.ch, plan, daysBetween(win.from, win.to));
      if (est.unknown.length)
        throw new MetricAuthoringError("COVERAGE_UNKNOWN", `No coverage for ${est.unknown.join(", ")}.`);
      if (est.estimatedRows > maxRows)
        throw new MetricAuthoringError(
          "COST_CAP",
          `Estimated ${est.estimatedRows} rows exceeds the cap of ${maxRows}.`,
        );
      const series = await executePlan(deps.ch, plan, win, limits(maxRows));
      const { gaps } = await bucketCoverages(deps.ch, plan, win);
      const providers = [...new Set(plan.tables.map((t) => t.provider).filter((x): x is string => !!x))];
      const wm = await loadWatermarks(deps.ch, providers);
      const pr = plan.proposal;
      const envelope: DataFrameEnvelope = {
        queryHash: sha256(
          canonicalJson({
            fp: plan.fingerprint,
            win,
            key: rec.metricKey,
            v: rec.version,
            h: rec.proposalHash,
          }),
        ),
        semanticVersion: deps.semanticVersion ?? deps.registry?.semanticVersion ?? "1.0.0",
        semanticModelHash: cat.hash,
        sourceSnapshotId: null,
        columns: [
          { name: "bucket", type: "time", unit: null },
          ...pr.dimensions.map((d) => ({ name: d.column, type: "string" as const, unit: null })),
          { name: rec.metricKey, type: "decimal", unit: pr.unit, scale: pr.precision.decimals },
        ],
        rows: series.rows.map((r) => [r.bucket, ...r.dims, r.value]),
        rowCoverage: series.rows.map((r) => r.coverage),
        nullCount: series.rows.filter((r) => r.value === null).length,
        partialCount: series.rows.filter((r) => r.coverage !== "complete").length,
        gaps: gaps.slice(0, 200).map((g) => ({ from: g.from, to: g.to, reason: g.reason })),
        sourceWatermarks: wm,
        certification:
          rec.status === "CERTIFIED" ? "certified" : rec.status === "DEPRECATED" ? "stale" : "experimental",
        cost: { bytesEstimated: 0, bytesBilled: 0 },
        planFingerprint: plan.fingerprint,
        generatedAt: clock().toISOString(),
        ...(exploratory
          ? {
              metricStatus: rec.status === "DRAFT" ? ("draft" as const) : ("validated" as const),
              exploratory: {
                banner: EXPLORATORY_BANNER,
                metricKey: rec.metricKey,
                metricVersion: rec.version,
                proposalHash: rec.proposalHash,
              },
            }
          : {}),
      };
      await ok(p, "explore", rec.metricKey, rec.version, {
        rows: envelope.rows.length,
        status: rec.status,
        trace: randomUUID(),
      });
      return { envelope, record: rec };
    },
  };
}

export type AuthoringService = ReturnType<typeof createAuthoringService>;
