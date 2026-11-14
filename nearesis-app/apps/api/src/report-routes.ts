import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { KernelError, microToUsd, workspaceNotFound } from "@nearesis/kernel";
import { usdCreditsOf } from "./usd-credits-api.ts";
import type { Kernel, Session } from "@nearesis/kernel";

export const REPORT_MAX_RUNS = 20;
export const REPORT_MAX_PANELS = 60;
const MAX_LIST = 200;
const MAX_TRIGGERS_PER_RULE = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ReportRoutesOptions {
  kernel: Kernel;
}

/** USD as a decimal string with 6 places, or null when no number is known. */
export function usd6(n: number | null | undefined): string | null {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(6) : null;
}

/** The planned objective of a run (the composer's), as the run page shows it; the root task is only "investigation". */
export function questionOf(run: J): string | null {
  const kids: J[] = Array.isArray(run.children) ? run.children : [];
  const q =
    kids.find((c) => c.role === "composer")?.objective ??
    kids[0]?.objective ??
    run.rootTask?.objective ??
    null;
  return typeof q === "string" ? q : null;
}

/** Panel hashes a finding rests on: its canvas panels first, then every query hash its cited cells name (deduplicated, in order). */
export function findingHashes(f: J, canvasHash: Map<string, string>): string[] {
  const out: string[] = [];
  const add = (h: unknown) => {
    if (typeof h === "string" && HASH.test(h) && !out.includes(h)) out.push(h);
  };
  for (const id of Array.isArray(f.panelIds) ? f.panelIds : []) add(canvasHash.get(id));
  for (const fact of Array.isArray(f.facts) ? f.facts : []) add(fact?.resultRef?.queryHash);
  return out;
}

const range = (ast: J | null | undefined): { from: string; to: string } | null => {
  const t = ast?.time;
  return t && typeof t.from === "string" && typeof t.to === "string" ? { from: t.from, to: t.to } : null;
};

/** What a panel's own data says about itself; null where the data does not say. */
export function describePanel(hash: string, canvas: J | undefined, data: J | null, error: J | null) {
  const chart: J | null = data?.chart ?? null;
  const prov: J | null = data?.provenance ?? null;
  const units = [
    ...new Set(
      ((chart?.columns as J[] | undefined) ?? [])
        .slice(1)
        .filter(
          (c) =>
            !Array.isArray(canvas?.encoding?.y) ||
            canvas.encoding.y.length === 0 ||
            canvas.encoding.y.includes(c.name),
        )
        .map((c) => c.unit)
        .filter((u): u is string => typeof u === "string"),
    ),
  ];
  const labels: string[] = Array.isArray(prov?.sources) ? prov.sources : [];
  const window = range(prov?.ast);
  return {
    hash,
    title: typeof canvas?.title === "string" ? canvas.title : null,
    kind: typeof canvas?.kind === "string" ? canvas.kind : null,
    /** The canvas encoding (x and y column names, scale) when the panel is on the canvas; the report draws what it names. */
    encoding: (canvas?.encoding ?? null) as J | null,
    unit: units.length ? units.join(", ") : null,
    source: prov?.sourceLabel ? `${prov.sourceLabel}${labels.length ? `: ${labels.join(", ")}` : ""}` : null,
    window,
    metricVersion: (prov?.semanticVersion ?? prov?.metricVersion ?? null) as string | null,
    coverage: data
      ? {
          state: data.state ?? null,
          gaps: Array.isArray(data.gaps) ? data.gaps.length : null,
          nullCount: data.nullCount ?? null,
          partialCount: data.partialCount ?? null,
          freshness: data.freshness?.state ?? null,
          sourceWatermark: data.freshness?.sourceWatermark ?? null,
        }
      : null,
    caveats: Array.isArray(data?.caveats) ? (data!.caveats as string[]) : [],
    gaps: Array.isArray(data?.gaps) ? (data!.gaps as J[]) : [],
    data,
    error,
  };
}

/**
 * `GET /v1/workspaces/:id/report` (any member, viewers included): the workspace as one JSON document for the print report.
 * Every part is read through the routes that already serve it (same validation, same tenant isolation), forwarding the
 * caller's own credentials, so the report can never show more than the caller can read. Nothing is generated here: a part
 * that cannot be read is null/empty and says so in `limitations`.
 */
export const reportRoutes: FastifyPluginAsync<ReportRoutesOptions> = async (app, { kernel }) => {
  const authenticate = async (req: FastifyRequest): Promise<Session> => {
    const h = req.headers.authorization;
    const token = h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
    return kernel.identity.resolveSession(token);
  };
  const credits = usdCreditsOf(kernel.db);

  app.get<{ Params: { id: string } }>("/v1/workspaces/:id/report", async (req) => {
    const s = await authenticate(req);
    const wid = req.params.id;
    if (!UUID.test(wid)) throw workspaceNotFound();
    let ws;
    try {
      ws = await kernel.workspaces.get(s, wid);
    } catch (e) {
      if (e instanceof KernelError && e.code === "FORBIDDEN") throw workspaceNotFound();
      throw e;
    }
    const limitations: string[] = [];
    const authz = req.headers.authorization as string;
    const read = async (
      url: string,
    ): Promise<{ ok: true; body: J } | { ok: false; status: number; reason: string }> => {
      const r = await (app as FastifyInstance).inject({
        method: "GET",
        url,
        headers: { authorization: authz },
      });
      let body: J = {};
      try {
        body = r.json() as J;
      } catch {
        /* not json */
      }
      return r.statusCode === 200
        ? { ok: true, body }
        : {
            ok: false,
            status: r.statusCode,
            reason: String(body.reasonCode ?? body.errorCode ?? r.statusCode),
          };
    };
    const base = `/v1/workspaces/${wid}`;
    const part = async (name: string, url: string): Promise<J | null> => {
      const r = await read(url);
      if (r.ok) return r.body;
      limitations.push(`${name} could not be read (${r.reason}); it is left out of this report.`);
      return null;
    };

    const [runList, canvas, hyp, mk, mon, evals, trig, burn, ledger, pubs] = await Promise.all([
      part("The run list", `${base}/runs`),
      part("The canvas", `${base}/canvas`),
      part("Hypotheses", `${base}/hypotheses`),
      part("Markers", `${base}/markers`),
      part("Monitors", `${base}/monitors`),
      part("Monitor evaluations", `${base}/monitors/evaluations`),
      part("Monitor triggers", `${base}/monitors/triggers`),
      part("The workspace cost summary", `${base}/cost/burn`),
      part("The workspace cost ledger", `${base}/cost/ledger?limit=200`),
      part("Publications", `/v1/publications`),
    ]);

    // ---- owner ----
    const owner = await kernel.db
      .tx({ orgId: s.principal.orgId, userId: s.userId }, async (tx) => {
        const r = await tx.query<{ display_name: string | null; near_account_id: string | null }>(
          "SELECT display_name, near_account_id FROM users WHERE id = $1",
          [ws.createdBy],
        );
        return r.rows[0]
          ? { displayName: r.rows[0].display_name, nearAccountId: r.rows[0].near_account_id }
          : null;
      })
      .catch(() => null);

    // ---- runs (newest first, bounded) ----
    const allRuns: J[] = ((runList?.runs as J[] | undefined) ?? []).slice();
    allRuns.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    if (allRuns.length > REPORT_MAX_RUNS)
      limitations.push(`Only the newest ${REPORT_MAX_RUNS} of ${allRuns.length} runs are included.`);
    const canvasPanels: J[] = (canvas?.panels as J[] | undefined) ?? [];
    const canvasHash = new Map<string, string>(
      canvasPanels
        .filter((p) => typeof p?.queryRef?.hash === "string")
        .map((p) => [p.panelId as string, p.queryRef.hash as string]),
    );
    const canvasByHash = new Map<string, J>();
    for (const p of canvasPanels)
      if (typeof p?.queryRef?.hash === "string" && !canvasByHash.has(p.queryRef.hash))
        canvasByHash.set(p.queryRef.hash, p);

    const runDetails = await mapLimit(allRuns.slice(0, REPORT_MAX_RUNS), 4, async (r) => {
      const d = await read(`/v1/runs/${r.runId}`);
      return d.ok
        ? d.body
        : (limitations.push(`Run ${String(r.runId).slice(0, 8)} could not be read (${d.reason}).`), null);
    });
    const runs: J[] = [];
    const hashOrder: string[] = [];
    const hashRuns = new Map<string, string[]>();
    for (const d of runDetails) {
      if (!d) continue;
      const findings: J[] = ((d.findings as J[] | undefined) ?? []).map((f) => ({
        ...f,
        panelHashes: findingHashes(f, canvasHash),
      }));
      const runHashes: string[] = [];
      for (const f of findings)
        for (const h of f.panelHashes as string[]) if (!runHashes.includes(h)) runHashes.push(h);
      for (const h of runHashes) {
        if (!hashOrder.includes(h)) hashOrder.push(h);
        hashRuns.set(h, [...(hashRuns.get(h) ?? []), d.runId]);
      }
      const interp = (d.interpretation as J | undefined) ?? { state: "none", reason: null, findingCount: 0 };
      if (d.terminal && interp.state !== "ready")
        limitations.push(
          `Run ${String(d.runId).slice(0, 8)} has no ready interpretation (${interp.state}${interp.reason ? `: ${interp.reason}` : ""}).`,
        );
      runs.push({
        id: d.runId,
        question: questionOf(d),
        state: d.state,
        terminal: d.terminal === true,
        source: d.source ?? null,
        createdAt: d.createdAt ?? null,
        updatedAt: d.updatedAt ?? null,
        budget: d.budget ?? null,
        // The runtime stores no written summary of a run; the report's summary is built from the findings themselves.
        interpretation: {
          state: interp.state,
          reason: interp.reason ?? null,
          findingCount: interp.findingCount ?? findings.length,
          summary: null,
          findings,
        },
        panelHashes: runHashes,
      });
    }

    // ---- panels (each hash once; data exactly as panels/:hash/data returns it) ----
    if (hashOrder.length > REPORT_MAX_PANELS)
      limitations.push(`Only the first ${REPORT_MAX_PANELS} of ${hashOrder.length} panels are included.`);
    const panels = await mapLimit(hashOrder.slice(0, REPORT_MAX_PANELS), 4, async (h) => {
      const r = await read(`${base}/panels/${h}/data`);
      if (!r.ok)
        limitations.push(
          `Panel ${h.slice(0, 8)} could not be read (${r.reason}); it is listed without data.`,
        );
      const p = describePanel(
        h,
        canvasByHash.get(h),
        r.ok ? r.body : null,
        r.ok ? null : { status: r.status, reasonCode: r.reason },
      );
      return { ...p, runIds: hashRuns.get(h) ?? [] };
    });
    if (panels.some((p) => p.data))
      limitations.push(
        "Panel data is read again from its source when the report is generated; values can differ from those a finding cited if the source has since been revised or extended.",
      );

    // ---- monitors ----
    const lastBy = new Map<string, J>();
    for (const e of (evals?.evaluations as J[] | undefined) ?? [])
      if (!lastBy.has(e.ruleId) || String(e.evaluatedAt) > String(lastBy.get(e.ruleId)!.evaluatedAt))
        lastBy.set(e.ruleId, e);
    const trigBy = new Map<string, J[]>();
    for (const t of (trig?.triggers as J[] | undefined) ?? [])
      trigBy.set(t.ruleId, [...(trigBy.get(t.ruleId) ?? []), t]);
    const monitors = ((mon?.rules as J[] | undefined) ?? []).slice(0, MAX_LIST).map((r) => ({
      ...r,
      lastEvaluation: lastBy.get(r.ruleId) ?? null,
      triggers: (trigBy.get(r.ruleId) ?? []).slice(0, MAX_TRIGGERS_PER_RULE),
      triggerCount: (trigBy.get(r.ruleId) ?? []).length,
    }));

    // ---- capsules of this workspace ----
    const mine: J[] = ((pubs?.publications as J[] | undefined) ?? [])
      .filter((p) => p.workspaceId === wid)
      .slice(0, 50);
    const proofIds = new Set<string>();
    const capsuleIds = new Set<string>(mine.map((p) => p.capsuleId as string));
    const capsules = await mapLimit(mine, 3, async (p) => {
      const enc = encodeURIComponent(p.capsuleId);
      const [view, proofs, pub] = await Promise.all([
        read(`/v1/capsules/${enc}`),
        read(`/v1/capsules/${enc}/proofs`),
        read(`/v1/capsules/${enc}/publication`),
      ]);
      if (!view.ok || view.body.status !== "available")
        limitations.push(
          `Capsule ${String(p.capsuleId).slice(0, 24)} could not be read; only its publication row is shown.`,
        );
      if (!proofs.ok)
        limitations.push(
          `Proofs of capsule ${String(p.capsuleId).slice(0, 24)} could not be read (${proofs.reason}).`,
        );
      const items: J[] = proofs.ok ? ((proofs.body.items as J[] | undefined) ?? []) : [];
      for (const it of items) proofIds.add(it.proofId);
      const {
        provenance: _pv,
        rebuild: _rb,
        exports: _ex,
        ...cap
      } = (view.ok && view.body.capsule ? view.body.capsule : {}) as J;
      return {
        capsuleId: p.capsuleId,
        title: p.title ?? null,
        label: p.label ?? null,
        createdAt: p.createdAt ?? null,
        ...cap,
        proofs: items,
        publication: {
          state: p.state ?? null,
          public: p.public === true,
          badge: p.badge ?? null,
          publishedAt: p.publishedAt ?? null,
          acknowledged: Array.isArray(p.acknowledged) ? p.acknowledged : [],
          record: pub.ok ? (pub.body.record ?? null) : null,
        },
      };
    });
    if (capsules.some((c) => (c.proofs as J[]).length))
      limitations.push(
        "Intel collateral (TCB status) is not checked for any OutLayer attestation in this report.",
      );

    // ---- costs ----
    const entries: J[] = [];
    let modelUsd: number | null = null;
    for (const r of runs) {
      const spent = r.budget?.spent?.usd;
      if (typeof spent === "number" && Number.isFinite(spent)) {
        modelUsd = (modelUsd ?? 0) + spent;
        entries.push({
          source: "run",
          label: `Investigation run ${String(r.id).slice(0, 8)}`,
          unit: "usd",
          amount: spent.toFixed(6),
          at: r.updatedAt,
          ref: r.id,
          txHash: null,
        });
      }
    }
    const agentUsd = await agentCostEntries(kernel, s, wid);
    for (const e of agentUsd.entries) {
      modelUsd = (modelUsd ?? 0) + Number(e.amount);
      entries.push(e);
    }
    let chargedMicro = 0n;
    const credit = (
      await credits.entries({ orgId: s.principal.orgId, userId: s.userId }, 500).catch(() => [])
    ).filter((e) => {
      const cid = typeof e.detail?.capsuleId === "string" ? e.detail.capsuleId : null;
      return (
        (e.refKind === "proof" && e.refId !== null && proofIds.has(e.refId)) ||
        (e.refKind === "publication" &&
          ((e.refId !== null && capsuleIds.has(e.refId)) || (cid !== null && capsuleIds.has(cid))))
      );
    });
    for (const e of credit) {
      if (e.kind === "charge") chargedMicro += e.amountMicro;
      entries.push({
        source: "credits",
        label: `${e.kind} (${e.refKind})`,
        unit: "usd",
        amount: microToUsd(e.amountMicro),
        at: e.createdAt,
        ref: e.refId,
        txHash: typeof e.detail?.txHash === "string" ? e.detail.txHash : null,
        kind: e.kind,
      });
    }
    const ledgerEntries: J[] = ((ledger?.entries as J[] | undefined) ?? []).slice(0, MAX_LIST);
    const costs = {
      modelUsd: usd6(modelUsd),
      creditsChargedUsd: microToUsd(chargedMicro),
      entries,
      ledger: {
        spentUsd: typeof burn?.spentUsd === "number" ? usd6(burn.spentUsd) : null,
        period: burn?.period ?? null,
        entries: ledgerEntries,
      },
      basis:
        "Model spend is the sum of the USD each included run recorded in its budget" +
        (agentUsd.table ? ", plus the agent cost entries of this workspace" : "") +
        ". Credits charged (USD) is the sum of charge entries in the caller's USD credits ledger that reference this workspace's capsule proofs and publications. The workspace cost ledger is shown separately and is not added to either total.",
    };

    const windows = panels.map((p) => p.window).filter((w): w is { from: string; to: string } => w !== null);
    const dataWindow = windows.length
      ? {
          from: windows.map((w) => w.from).sort()[0]!,
          to: windows
            .map((w) => w.to)
            .sort()
            .at(-1)!,
        }
      : null;

    return {
      generatedAt: new Date().toISOString(),
      workspace: {
        id: ws.id,
        objective: ws.objective,
        networkScope: ws.networkScope,
        version: ws.version,
        createdAt: ws.createdAt,
        archivedAt: ws.archivedAt ?? null,
        owner,
        dataWindow,
      },
      runs,
      panels,
      hypotheses: ((hyp?.hypotheses as J[] | undefined) ?? []).slice(0, MAX_LIST),
      markers: ((mk?.markers as J[] | undefined) ?? []).slice(0, MAX_LIST),
      monitors,
      capsules,
      costs,
      limitations,
    };
  });
};

/**
 * Model spend recorded by the Agent tab for this workspace (table `agent_cost_entries`, migration 023). A database that
 * does not have the table, or not the columns read here, simply has none: the report then relies on the run budgets.
 */
async function agentCostEntries(
  kernel: Kernel,
  s: Session,
  workspaceId: string,
): Promise<{ table: boolean; entries: J[] }> {
  try {
    return await kernel.db.tx({ orgId: s.principal.orgId, userId: s.userId }, async (tx) => {
      const reg = await tx.query<{ t: string | null }>(
        "SELECT to_regclass('public.agent_cost_entries')::text AS t",
      );
      if (!reg.rows[0]?.t) return { table: false, entries: [] };
      const cols = await tx.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_cost_entries'",
      );
      const have = new Set(cols.rows.map((c) => c.column_name));
      const need = ["workspace_id", "user_id", "unit", "amount", "label", "created_at"];
      if (!need.every((c) => have.has(c))) return { table: false, entries: [] };
      const r = await tx.query<{ amount: string; label: string; created_at: Date; tx_hash?: string | null }>(
        `SELECT amount::text AS amount, label, created_at${have.has("tx_hash") ? ", tx_hash" : ""} FROM agent_cost_entries WHERE workspace_id = $1 AND user_id = $2 AND unit = 'usd' ORDER BY created_at DESC LIMIT 200`,
        [workspaceId, s.userId],
      );
      return {
        table: true,
        entries: r.rows.map((x) => ({
          source: "agent",
          label: x.label,
          unit: "usd",
          amount: Number(x.amount).toFixed(6),
          at: x.created_at.toISOString(),
          ref: null,
          txHash: x.tx_hash ?? null,
        })),
      };
    });
  } catch {
    return { table: false, entries: [] };
  }
}

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}
